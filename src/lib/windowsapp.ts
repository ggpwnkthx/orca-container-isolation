/**
 * Installing the Orca app on Windows.
 *
 * There is no AppImage and no disk image on Windows: the release carries
 * an installer (orca-windows-setup.exe), which is downloaded, checked and
 * then run -- the user finishes the wizard.
 *
 * The installer is not run silently: it is an ordinary Windows program,
 * and the user sees what it does.
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

/** The installer for this machine, and the checksum file that lists it. */
export function windowsAssetNames(): { asset: string; yml: string } {
  // The Windows installer is the same on both architectures.
  return { asset: "orca-windows-setup.exe", yml: "latest.yml" };
}

/** Where the installer is kept while it is checked and run. */
export function windowsAppPaths(): { dir: string; installer: string } {
  const dir = process.env.ORCA_APP_DIR ?? join(homedir(), "Downloads");
  return { dir, installer: join(dir, "orca-windows-setup.exe") };
}

/**
 * Install the Orca app on Windows.
 *
 * `from` is an installer the user downloaded themselves; when it is empty
 * the latest release is used.
 */
export async function installWindowsApp(from: string): Promise<void> {
  const { asset } = windowsAssetNames();
  const { dir, installer } = windowsAppPaths();
  const api = process.env.ORCA_BOX_GITHUB_API ?? "https://api.github.com";

  mkdirSync(dir, { recursive: true });
  const work = join(dataWork(), "windowsapp");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const download = join(work, "setup.exe");

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
      windowsAssetNames(),
    );
    if (!info.url) {
      die(
        `release ${info.version || "latest"} has no ${asset}. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE`,
      );
    }

    say(`Downloading Orca ${info.version} (${asset})`);
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
    } else if (info.ymlUrl) {
      let ymlText = "";
      try {
        ymlText = await fetchText(info.ymlUrl);
      } catch {
        ymlText = "";
      }
      const want = ymlText ? sha512FromYml(ymlText, asset) : "";
      if (!want) {
        die(`no sha512 for this file in ${windowsAssetNames().yml}; not installing`);
      }
      if (sha512FileBase64(download) !== want) {
        die(
          `the download doesn't match the SHA-512 in ${windowsAssetNames().yml}; not installing`,
        );
      }
      say(`Verified SHA-512 against ${windowsAssetNames().yml}`);
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

  // Keep a copy, so the user can run it again.
  try {
    copyFileSync(download, installer);
  } catch {
    // Not important; the installer runs from the work folder either way.
  }

  say("Running the Orca installer; follow the instructions on screen");
  const code = Bun.spawnSync([download], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  }).exitCode;
  if (code !== 0) {
    warn(
      `the installer didn't finish cleanly (exit ${code}). You can run it again from\n` +
        `    ${installer}`,
    );
  }

  rmSync(work, { recursive: true, force: true });
  say(`The installer is kept at ${installer}`);
}

/**
 * Where Orca is installed on this machine.
 *
 * The installer puts it in the user's own programs folder; these are the
 * places it is looked for.
 */
export function findWindowsOrca(): string {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const candidates = [
    join(local, "Programs", "Orca", "Orca.exe"),
    join(local, "Programs", "orca", "Orca.exe"),
    join(local, "Programs", "orca-ide", "Orca.exe"),
    join(programFiles, "Orca", "Orca.exe"),
    join(programFiles, "orca", "Orca.exe"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Look in the programs folder itself: the name may differ.
  const programs = join(local, "Programs");
  try {
    for (const entry of readdirSync(programs)) {
      if (!entry.toLowerCase().includes("orca")) continue;
      const exe = join(programs, entry, "Orca.exe");
      if (existsSync(exe)) return exe;
    }
  } catch {
    // No programs folder.
  }
  return "";
}

/** Remove the installer this installer put away. */
export function removeWindowsApp(): void {
  const { installer } = windowsAppPaths();
  if (existsSync(installer)) {
    rmSync(installer, { force: true });
    say(`Removed ${installer}`);
  }
  say("The Orca app itself is removed from Windows' Installed apps.");
}
