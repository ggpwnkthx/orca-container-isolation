/**
 * What platform are we on?
 *
 * orca-box runs on Linux and on macOS. Most of it is the same on both; the
 * parts that differ -- the Orca app, the application-menu entry, the daily
 * update, the file lock, the container flags -- ask this module instead of
 * scattering `process.platform` checks around.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type OsName = "linux" | "darwin" | "win32";

/** The operating system we are running on. */
export function osName(): OsName {
  switch (process.platform) {
    case "linux":
      return "linux";
    case "darwin":
      return "darwin";
    case "win32":
      return "win32";
    default:
      return "linux";
  }
}

/** Are we on macOS? */
export function isMac(): boolean {
  return osName() === "darwin";
}

/** Are we on Linux? */
export function isLinux(): boolean {
  return osName() === "linux";
}

/** Are we on Windows? */
export function isWindows(): boolean {
  return osName() === "win32";
}

/** The name of a program, with the .exe left off on Windows. */
export function programName(name: string): string {
  if (!isWindows()) return name;
  return name.replace(/\.exe$/i, "");
}

/** The CPU architecture, as the release assets name it. */
export function archTag(): "x64" | "arm64" {
  return process.arch === "arm64" ? "arm64" : "x64";
}

/**
 * Where the settings live.
 *
 * The same layout on both platforms -- the XDG base directory spec, which
 * works on macOS too -- so the paths in the README are the same
 * everywhere. The environment variables can override it either way.
 *
 * On Windows there is no ~/.config, so the settings live under the
 * user's local application data.
 */
export function configHome(): string {
  const fromEnv = process.env.XDG_CONFIG_HOME;
  if (fromEnv) return fromEnv;
  if (isWindows()) {
    // The roaming application data folder: %APPDATA%\<app>\...
    const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return roaming;
  }
  return join(homedir(), ".config");
}

/** Where the program's own data lives. */
export function dataHome(): string {
  const fromEnv = process.env.XDG_DATA_HOME;
  if (fromEnv) return fromEnv;
  if (isWindows()) {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "orca-box");
  }
  return join(homedir(), ".local", "share");
}

/** The name of the operating system, as the release assets spell it. */
export function assetOsName(): string {
  return isWindows() ? "windows" : osName();
}

/** The name of this program's release asset for this machine. */
export function programAsset(): string {
  return `orca-box-${assetOsName()}-${archTag()}`;
}

/** Where this program's release asset is downloaded from. */
export function programAssetUrl(base = defaultReleaseBase()): string {
  return `${base.replace(/\/+$/, "")}/releases/latest/download/${programAsset()}`;
}

/** The project's GitHub repository, for releases. */
export function defaultReleaseBase(): string {
  return process.env.ORCA_BOX_REPO_BASE ?? "https://github.com/ggpwnkthx/orca-container-isolation";
}

/**
 * Can Docker Desktop see this folder?
 *
 * Docker Desktop on macOS runs the containers in a Linux virtual machine
 * and shares only some of the disk with it: the home folder, /Volumes,
 * /private and /tmp. A worktree outside those cannot be mounted into a
 * box, so it is worth saying so before the box fails to start.
 */
export function isShareableOnMac(path: string): boolean {
  if (!isMac()) return true;
  const roots = ["/Users", "/Volumes", "/private", "/tmp", "/opt/homebrew"];
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}
