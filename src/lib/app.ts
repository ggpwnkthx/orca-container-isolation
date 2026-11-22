/**
 * The Orca app, on whichever platform we are on.
 *
 * Linux gets an AppImage and a .desktop entry; macOS gets a disk image
 * with an application bundle in it. Everything else in the program asks
 * this module, so the two implementations can change on their own.
 */

import { isMac, isWindows } from "./platform.ts";
import {
  appPaths as linuxPaths,
  installAppImage,
  removeAppImage,
} from "./appimage.ts";
import {
  installMacApp,
  macAppPaths,
  macAssetNames,
  removeMacApp,
} from "./macapp.ts";
import {
  findWindowsOrca,
  installWindowsApp,
  removeWindowsApp,
  windowsAssetNames,
} from "./windowsapp.ts";

export interface AppPaths {
  /** The folder the app is installed in. */
  dir: string;
  /** The app itself. */
  dest: string;
  /** The folder with the menu entries (Linux only). */
  apps: string;
  /** The folder with the icons (Linux only). */
  icons: string;
  /** The .desktop file (Linux only). */
  desktopFile: string;
}

/** Where the app and its menu entry live. */
export function appPaths(): AppPaths {
  if (isMac()) {
    const { dir, dest } = macAppPaths();
    return { dir, dest, apps: "", icons: "", desktopFile: "" };
  }
  if (isWindows()) {
    // The app is an installed program, not a file we keep.
    const dir = process.env.ORCA_APP_DIR ?? "";
    return { dir, dest: findWindowsOrca(), apps: "", icons: "", desktopFile: "" };
  }
  return linuxPaths();
}

/**
 * The release asset for this machine, and the checksum file that may list
 * it.
 */
export function assetNames(): { asset: string; yml: string } {
  if (isMac()) return macAssetNames();
  if (isWindows()) return windowsAssetNames();
  const arch = process.arch === "arm64" ? "arm64" : "x86_64";
  if (arch === "arm64") {
    return { asset: "orca-linux-arm64.AppImage", yml: "latest-linux-arm64.yml" };
  }
  return { asset: "orca-linux.AppImage", yml: "latest-linux.yml" };
}

/** Install the Orca app, from a release or from a file the user has. */
export async function installOrcaApp(from: string): Promise<void> {
  if (isMac()) {
    await installMacApp(from);
    return;
  }
  if (isWindows()) {
    await installWindowsApp(from);
    return;
  }
  await installAppImage(from);
}

/** Remove the Orca app and its menu entry. */
export function removeApp(): void {
  if (isMac()) {
    removeMacApp();
    return;
  }
  if (isWindows()) {
    removeWindowsApp();
    return;
  }
  removeAppImage();
}
