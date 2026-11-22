/**
 * Installing the Orca app on Linux.
 *
 * The AppImage comes from a GitHub release; its checksum is checked against
 * the one GitHub publishes, or else against the SHA-512 in the release's
 * latest-linux.yml (what Orca's own updater uses). With neither available
 * it refuses, unless ORCA_BOX_ALLOW_UNVERIFIED=1.
 *
 * On macOS the app is a bundle in a disk image; see macapp.ts.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataHome } from "./platform.ts";
import { dataWork } from "./paths.ts";
import { releaseInfo } from "./release.ts";
import { die, say, warn } from "./output.ts";
import { hasCommand } from "./which.ts";

const REPO = "stablyai/orca";
const DESKTOP_ID = "orca-ide";

/** Where the app and its menu entry live. */
export function appPaths(): {
  dir: string;
  dest: string;
  apps: string;
  icons: string;
  desktopFile: string;
} {
  const dir = process.env.ORCA_APPIMAGE_DIR ?? join(homedir(), "AppImages");
  return {
    dir,
    dest: join(dir, "orca.AppImage"),
    apps: join(dataHome(), "applications"),
    icons: join(dataHome(), "icons", "hicolor"),
    desktopFile: join(dataHome(), "applications", `${DESKTOP_ID}.desktop`),
  };
}

/** The AppImage asset for this machine, and the yml file that may list it. */
export function assetNames(): { asset: string; yml: string } {
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  if (arch === "arm64") {
    return { asset: "orca-linux-arm64.AppImage", yml: "latest-linux-arm64.yml" };
  }
  return { asset: "orca-linux.AppImage", yml: "latest-linux.yml" };
}

/** Fetch a URL, following redirects. Returns the response body. */
export async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "orca-box-installer" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.text();
}

/** Fetch a URL to a file, following redirects. */
export async function fetchToFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "orca-box-installer" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  await Bun.write(dest, response);
}

/** The SHA-256 of a file, as hex. */
export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * The SHA-512 the release's latest-linux.yml publishes for an asset.
 *
 * The file is a YAML list; the sha512 belongs to the entry whose url is
 * the asset we downloaded.
 */
export function sha512FromYml(yml: string, asset: string): string {
  let current = "";
  for (const raw of yml.split("\n")) {
    const line = raw.trim().replace(/^-\s*/, "").trim();
    if (line.startsWith("url:")) {
      current = line.slice("url:".length).trim().replace(/^["']|["']$/g, "");
    } else if (line.startsWith("sha512:") && current === asset) {
      return line.slice("sha512:".length).trim().replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

/** The SHA-512 of a file, as base64 (how the yml lists it). */
export function sha512FileBase64(path: string): string {
  return createHash("sha512").update(readFileSync(path)).digest("base64");
}

/** Tell desktop environments about the change. */
export function refreshMenus(apps: string): void {
  // (No icon-theme.cache in your own icon folder: one that goes stale
  //  hides other apps' new icons.)
  if (hasCommand("update-desktop-database")) {
    Bun.spawnSync(["update-desktop-database", "-q", apps], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  for (const tool of ["kbuildsycoca6", "kbuildsycoca5"]) {
    if (!hasCommand(tool)) continue;
    Bun.spawnSync([tool], { stdout: "ignore", stderr: "ignore" });
    break;
  }
}

/**
 * Install the Orca app from a release, or from an AppImage the user has.
 *
 * This is the Linux half; app.ts picks between this and the macOS one.
 */
export async function installAppImage(from: string): Promise<void> {
  const { asset, yml } = assetNames();
  const { dir, dest } = appPaths();
  const api = process.env.ORCA_BOX_GITHUB_API ?? "https://api.github.com";

  mkdirSync(dir, { recursive: true });
  const work = join(dataWork(), "appimage");
  mkdirSync(work, { recursive: true });
  const newApp = join(work, "new.AppImage");

  let version = "";

  if (from) {
    if (!existsSync(from)) die(`no such file: ${from}`);
    copyFileSync(from, newApp);
    say(`Installing ${from}`);
  } else {
    say("Looking up the latest Orca release");
    let release: unknown;
    try {
      release = JSON.parse(
        await fetchText(`${api}/repos/${REPO}/releases/latest`),
      );
    } catch {
      die(
        "couldn't reach GitHub's API. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE",
      );
    }
    const info = await releaseInfo(
      release as Parameters<typeof releaseInfo>[0],
      assetNames(),
    );
    version = info.version;
    if (!info.url) {
      die(
        `release ${version || "latest"} has no ${asset}. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE`,
      );
    }

    // Already have exactly this build? (Orca's updater may have got there first.)
    if (info.sha256 && existsSync(dest) && sha256File(dest) === info.sha256) {
      say(`Orca ${version} is already installed at ${dest}`);
    } else {
      say(`Downloading Orca ${version} (${asset})`);
      try {
        await fetchToFile(info.url, newApp);
      } catch (err) {
        die(`couldn't download Orca: ${(err as Error).message}`);
      }

      if (info.sha256) {
        if (sha256File(newApp) !== info.sha256) {
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
        if (ymlText) {
          const want = sha512FromYml(ymlText, asset);
          if (!want) {
            die(`no sha512 for this file in ${yml}; not installing`);
          }
          if (sha512FileBase64(newApp) !== want) {
            die(`the download doesn't match the SHA-512 in ${yml}; not installing`);
          }
          say(`Verified SHA-512 against ${yml}`);
        } else if (process.env.ORCA_BOX_ALLOW_UNVERIFIED === "1") {
          warn(
            `no checksum published for ${asset}; installing unverified (ORCA_BOX_ALLOW_UNVERIFIED=1)`,
          );
        } else {
          die(
            `no checksum published for ${asset}, so it can't be verified. Set ORCA_BOX_ALLOW_UNVERIFIED=1 to install anyway.`,
          );
        }
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
  }

  if (existsSync(newApp)) {
    // Is it even an AppImage?
    const head = readFileSync(newApp).subarray(0, 4);
    if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) {
      die("that file isn't an AppImage (not an ELF executable)");
    }
    chmodSync(newApp, 0o755);
    // Same-folder rename: atomic, and a running Orca keeps its old copy open.
    const tmp = join(dir, `.orca.AppImage.${process.pid}`);
    copyFileSync(newApp, tmp);
    chmodSync(tmp, 0o755);
    renameSync(tmp, dest);
    say(`Installed ${dest}`);
  }

  // --- menu entry, from the .desktop file and icons inside the AppImage ---
  say("Adding Orca to the application menu");
  const extract = join(work, "extract");
  mkdirSync(extract, { recursive: true });
  for (const pattern of ["*.desktop", "usr/share/icons/*", ".DirIcon"]) {
    Bun.spawnSync([dest, "--appimage-extract", pattern], {
      cwd: extract,
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  const root = join(extract, "squashfs-root");

  // An AppImage mounts itself with FUSE to run. Where FUSE isn't there,
  // extract it once and run the extracted copy instead: that works
  // everywhere, at the cost of some disk.
  let program = dest;
  if (!hasFuse()) {
    const unpacked = `${dest}.d`;
    say("This system has no FUSE, so Orca is extracted instead of mounted");
    rmSync(unpacked, { recursive: true, force: true });
    mkdirSync(unpacked, { recursive: true });
    const done = Bun.spawnSync([dest, "--appimage-extract"], {
      cwd: unpacked,
      stdout: "ignore",
      stderr: "ignore",
    });
    const appRun = join(unpacked, "squashfs-root", "AppRun");
    if (done.exitCode === 0 && existsSync(appRun)) {
      chmodSync(appRun, 0o755);
      program = appRun;
    } else {
      rmSync(unpacked, { recursive: true, force: true });
      warn(
        "couldn't extract Orca, and this system has no FUSE to mount it with;\n" +
          "    install fuse3 (or fuse) with your package manager, then rerun\n" +
          "    orca-box-install-orca",
      );
    }
  }

  if (!installIcons(root) && !installFallbackIcon(root)) {
    warn("couldn't extract Orca's icon; the menu entry will use a generic one");
  }

  const { desktopFile } = appPaths();
  if (existsSync(desktopFile) && !readFileSync(desktopFile, "utf8").includes("X-Orca-Box=true")) {
    copyFileSync(desktopFile, `${desktopFile}.bak`);
    warn(`replaced an existing ${desktopFile} (saved as ${desktopFile}.bak)`);
  }

  let embedded = "";
  try {
    for (const entry of readdirSync(root)) {
      if (entry.endsWith(".desktop")) {
        embedded = join(root, entry);
        break;
      }
    }
  } catch {
    embedded = "";
  }
  writeDesktopFile(embedded, dest, "orca-ide", version, program);

  rmSync(work, { recursive: true, force: true });
}

/** Remove the app and its menu entry. */
export function removeAppImage(): void {
  const { dest, apps, icons, desktopFile } = appPaths();

  if (existsSync(desktopFile)) {
    const content = readFileSync(desktopFile, "utf8");
    if (!content.includes("X-Orca-Box=true")) {
      warn(`${desktopFile} wasn't created by orca-box; leaving it`);
    } else {
      rmSync(desktopFile, { force: true });
    }
  }
  // The icons this installer put there.
  Bun.spawnSync([
    "find",
    icons,
    "-path",
    `*/apps/${DESKTOP_ID}.*`,
    "-delete",
  ]);
  rmSync(dest, { force: true });
  // The extracted copy, on a system without FUSE.
  rmSync(`${dest}.d`, { recursive: true, force: true });
  refreshMenus(apps);
  say(`Removed ${dest} and its menu entry (Orca's settings in ~/.config/orca are untouched).`);
}

/**
 * Can this machine run an AppImage directly?
 *
 * An AppImage mounts itself with FUSE. Extracting one doesn't need FUSE, so
 * the installer can fall back to extracting it on a system without it --
 * but running the app later does need it, unless it's extracted.
 */
export function hasFuse(): boolean {
  try {
    if (!existsSync("/dev/fuse")) return false;
  } catch {
    return false;
  }
  // The AppImage runtime links against the system's fuse library.
  const dirs = [
    ...(process.env.LD_LIBRARY_PATH ?? "").split(":"),
    "/lib/x86_64-linux-gnu",
    "/lib/aarch64-linux-gnu",
    "/lib64",
    "/usr/lib/x86_64-linux-gnu",
    "/usr/lib/aarch64-linux-gnu",
    "/usr/lib64",
    "/usr/lib",
    "/lib",
  ];
  const names = ["libfuse.so.2", "libfuse.so.3", "libfuse3.so.3"];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of names) {
      try {
        if (existsSync(join(dir, name))) return true;
      } catch {
        // Keep looking.
      }
    }
  }
  return false;
}

/**
 * Write the .desktop file, from the one inside the AppImage.
 *
 * The AppImage's own .desktop file is the source of truth; we replace the
 * program with the path we installed it to, and point the icon at the one
 * we extracted.
 *
 * `program` is what actually gets run: the AppImage itself normally, or
 * the extracted copy on a system without FUSE.
 */
export function writeDesktopFile(
  embeddedPath: string,
  dest: string,
  icon: string,
  version: string,
  program = dest,
): void {
  const { desktopFile, apps } = appPaths();
  let lines: string[] = [];
  if (embeddedPath && existsSync(embeddedPath)) {
    try {
      lines = readFileSync(embeddedPath, "utf8").split("\n");
    } catch {
      lines = [];
    }
  }
  if (!lines.some((l) => l.trim() === "[Desktop Entry]")) {
    lines = [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Orca",
      "Comment=Run a fleet of coding agents in parallel",
      "Exec=AppRun %U",
      "Terminal=false",
      "Categories=Development;Utility;",
      "StartupWMClass=orca",
    ];
  }

  // Quote the path for the Exec line: it can contain spaces.
  const programQuoted = `"${program.replace(/([`$\\])/g, "\\$1")}"`;
  const result: string[] = [];
  for (let line of lines) {
    if (line.startsWith("[")) {
      // A new section.
    } else if (line.includes("=")) {
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1);
      if (key === "Exec") {
        // Replace the program (AppRun) with the installed app; keep its
        // arguments.
        const parts = value.trim().split(/\s+/, 2);
        line = `Exec=${programQuoted}${parts.length > 1 ? ` ${parts[1]}` : " %U"}`;
      } else if (key === "TryExec" || key.startsWith("X-AppImage") || key === "X-Orca-Box") {
        continue;
      } else if (key === "Icon") {
        line = `Icon=${icon}`;
      }
    }
    result.push(line);
    if (line.trim() === "[Desktop Entry]") {
      result.push(`TryExec=${program}`);
      result.push("X-Orca-Box=true");
      if (version) {
        result.push(`X-AppImage-Version=${version.replace(/^v/, "")}`);
      }
    }
  }
  if (!result.some((l) => l.startsWith("Icon="))) {
    const at = result.indexOf("[Desktop Entry]") + 1;
    result.splice(at, 0, `Icon=${icon}`);
  }

  mkdirSync(apps, { recursive: true });
  writeFileSync(desktopFile, `${result.join("\n")}\n`);
  chmodSync(desktopFile, 0o644);

  if (hasCommand("desktop-file-validate")) {
    Bun.spawnSync(["desktop-file-validate", desktopFile], {
      stdout: "ignore",
      stderr: "inherit",
    });
  }
  refreshMenus(apps);
  say(`Menu entry: ${desktopFile}`);
}

/** Copy the icons out of the extracted AppImage. */
export function installIcons(root: string): boolean {
  const { icons } = appPaths();
  const hicolor = join(root, "usr", "share", "icons", "hicolor");
  if (!existsSync(hicolor)) return false;

  let found = false;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".png") || entry.name.endsWith(".svg")) {
        // e.g. 256x256/apps/orca-ide.png
        const rel = full.slice(hicolor.length + 1);
        const size = rel.split("/")[0] ?? "";
        const dest = join(icons, size, "apps");
        mkdirSync(dest, { recursive: true });
        copyFileSync(full, join(dest, `${DESKTOP_ID}.${entry.name}`));
        found = true;
      }
    }
  };
  walk(hicolor);
  return found;
}

/** The generic icon, for when the AppImage ships none we can use. */
export function installFallbackIcon(root: string): boolean {
  const { icons } = appPaths();
  const dirIcon = join(root, ".DirIcon");
  if (!existsSync(dirIcon)) return false;
  const dest = join(icons, "256x256", "apps");
  mkdirSync(dest, { recursive: true });
  copyFileSync(dirIcon, join(dest, `${DESKTOP_ID}.png`));
  return true;
}
