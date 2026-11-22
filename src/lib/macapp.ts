/**
 * Installing the Orca app on macOS.
 *
 * There is no AppImage on macOS: the release carries a disk image with an
 * application bundle in it. The installer mounts the image, copies the
 * bundle into the user's own Applications folder, and unmounts it again.
 * The bundle is the application-menu entry, so there is no .desktop file
 * to write.
 *
 * The download is checked against the SHA-256 digest GitHub publishes for
 * the file, or else against the SHA-512 in the release's latest-mac.yml.
 * With neither available it refuses, unless ORCA_BOX_ALLOW_UNVERIFIED=1.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  fetchText,
  fetchToFile,
  sha256File,
  sha512FileBase64,
  sha512FromYml,
} from "./appimage.ts";
import { releaseInfo } from "./release.ts";
import { dataWork } from "./paths.ts";
import { die, say, warn } from "./output.ts";
import { runIfPresent } from "./which.ts";

/** The name of the application bundle inside the disk image. */
const BUNDLE = "Orca.app";

/** Where the app lives, and where it is mounted while it is installed. */
export function macAppPaths(): { dir: string; dest: string } {
  const dir = process.env.ORCA_APP_DIR ?? join(homedir(), "Applications");
  return { dir, dest: join(dir, BUNDLE) };
}

/** The disk image for this machine, and the yml file that may list it. */
export function macAssetNames(): { asset: string; yml: string } {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return {
    asset: `orca-macos-${arch}.dmg`,
    // Electron Builder publishes the checksums of the macOS files in
    // latest-mac.yml; some releases have one per architecture.
    yml: "latest-mac.yml",
  };
}

/** The checksum files a release may carry for macOS, most likely first. */
function macYmlCandidates(): string[] {
  return process.arch === "arm64"
    ? ["latest-mac-arm64.yml", "latest-mac.yml"]
    : ["latest-mac.yml", "latest-mac-arm64.yml"];
}

/**
 * Install the Orca app on macOS.
 *
 * `from` is a disk image (or zip) the user downloaded themselves; when it
 * is empty the latest release is used.
 */
export async function installMacApp(from: string): Promise<void> {
  const { asset } = macAssetNames();
  const { dir, dest } = macAppPaths();
  const api = process.env.ORCA_BOX_GITHUB_API ?? "https://api.github.com";

  mkdirSync(dir, { recursive: true });
  const work = join(dataWork(), "macapp");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const download = join(work, "download");
  let version = "";

  if (from) {
    if (!existsSync(from)) die(`no such file: ${from}`);
    say(`Installing ${from}`);
    copyFileSync(from, download);
  } else {
    say("Looking up the latest Orca release");
    let release: unknown;
    try {
      release = JSON.parse(
        await fetchText(`${api}/repos/stablyai/orca/releases/latest`),
      );
    } catch {
      die(
        "couldn't reach GitHub's API. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE",
      );
    }
    const info = await releaseInfo(
      release as Parameters<typeof releaseInfo>[0],
      macAssetNames(),
    );
    version = info.version;
    if (!info.url) {
      die(
        `release ${version || "latest"} has no ${asset}. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE`,
      );
    }

    // The checksum file may be named after the architecture.
    const releaseAssets = new Map(
      (((release as { assets?: { name?: string; browser_download_url?: string }[] }).assets ?? []) as {
        name?: string;
        browser_download_url?: string;
      }[]).map((a) => [a.name ?? "", a] as const),
    );
    const ymlName =
      macYmlCandidates().find((name) => releaseAssets.has(name)) ?? "";
    const ymlUrl = info.ymlUrl || releaseAssets.get(ymlName)?.browser_download_url || "";

    say(`Downloading Orca ${version} (${asset})`);
    try {
      await fetchToFile(info.url, download);
    } catch (err) {
      die(`couldn't download Orca: ${(err as Error).message}`);
    }

    if (info.sha256) {
      if (sha256File(download) !== info.sha256) {
        die("SHA-256 of the download doesn't match GitHub's digest; not installing");
      }
      say("Verified SHA-256 against GitHub's digest");
    } else if (ymlUrl) {
      let ymlText = "";
      try {
        ymlText = await fetchText(ymlUrl);
      } catch {
        ymlText = "";
      }
      const want = ymlText ? sha512FromYml(ymlText, asset) : "";
      if (!want) {
        die(`no sha512 for this file in ${ymlName}; not installing`);
      }
      if (sha512FileBase64(download) !== want) {
        die(`the download doesn't match the SHA-512 in ${ymlName}; not installing`);
      }
      say(`Verified SHA-512 against ${ymlName}`);
    } else if (process.env.ORCA_BOX_ALLOW_UNVERIFIED === "1") {
      warn(
        `no checksum published for ${asset}; installing unverified (ORCA_BOX_ALLOW_UNVERIFIED=1)`,
      );
    } else {
      die(
        `no checksum published for ${asset}, so it can't be verified. Set ORCA_BOX_ALLOW_UNVERIFIED=1 to install anyway.`,
      );
    }
  }

  // --- get the bundle out of the disk image ------------------------------
  const mount = join(work, "mnt");
  mkdirSync(mount, { recursive: true });

  const isZip = download.endsWith(".zip");
  let source = "";
  if (isZip) {
    say("Unpacking the application bundle");
    // ditto unpacks a zip and keeps the bundle's structure; unzip, when
    // it is there, is the fallback.
    const unpacked = runIfPresent("ditto", ["-x", "-k", download, work]);
    if (unpacked !== 0) {
      runIfPresent("unzip", ["-q", "-o", download, "-d", work]);
    }
    source = findBundle(work);
    if (!source) {
      die("the archive doesn't contain an application bundle");
    }
  } else {
    const attached = runIfPresent("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-mountpoint",
      mount,
      download,
    ]);
    if (attached !== 0) {
      die("couldn't mount the disk image");
    }
    try {
      source = findBundle(mount);
      if (!source) {
        die("the disk image doesn't contain an application bundle");
      }
    } finally {
      runIfPresent("hdiutil", ["detach", mount]);
    }
  }

  // --- put the bundle in place -------------------------------------------
  say(`Installing ${BUNDLE} to ${dir}`);
  // The old copy goes first: copying over a bundle leaves stale files
  // from the previous version behind.
  rmSync(dest, { recursive: true, force: true });
  // ditto keeps the bundle's structure, its permissions and its symlinks.
  const copied = runIfPresent("ditto", [source, dest]);
  if (copied !== 0) {
    runIfPresent("cp", ["-R", source, dest]);
  }

  if (!existsSync(dest)) {
    die("the application bundle wasn't installed");
  }

  // The download was verified, so the quarantine flag that stops a
  // downloaded app from starting can go: it would ask the user to
  // confirm an app that came from this very installer.
  runIfPresent("xattr", ["-dr", "com.apple.quarantine", dest]);

  say(`Installed ${dest}`);
  say("It is in your Applications folder; open it from there.");
  rmSync(work, { recursive: true, force: true });
}

/** Find the application bundle in a folder, however deep it is. */
function findBundle(root: string): string {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return "";
  }
  for (const entry of entries) {
    if (entry.endsWith(".app")) return join(root, entry);
  }
  // One level down: some images have the bundle inside a folder.
  for (const entry of entries) {
    const full = join(root, entry);
    try {
      const inner = readdirSync(full);
      for (const name of inner) {
        if (name.endsWith(".app")) return join(full, name);
      }
    } catch {
      // Not a folder.
    }
  }
  return "";
}

/** Remove the app. */
export function removeMacApp(): void {
  const { dest } = macAppPaths();
  if (!existsSync(dest)) {
    say(`There is no Orca app at ${dest}.`);
    return;
  }
  rmSync(dest, { recursive: true, force: true });
  say(`Removed ${dest} (Orca's settings in ~/Library/Application Support/orca are untouched).`);
}
