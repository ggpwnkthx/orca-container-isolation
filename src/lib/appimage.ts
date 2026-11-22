/**
 * Installing the Orca app.
 *
 * The AppImage comes from a GitHub release; its checksum is checked against
 * the one GitHub publishes, or else against the SHA-512 in the release's
 * latest-linux.yml (what Orca's own updater uses). With neither available
 * it refuses, unless ORCA_BOX_ALLOW_UNVERIFIED=1.
 */

import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { die, say, warn } from "./output.ts";

const REPO = "stablyai/orca";
const DESKTOP_ID = "orca-ide";

export interface AppImageInfo {
  version: string;
  url: string;
  sha256: string;
  ymlUrl: string;
}

/** Where the app and its menu entry live. */
export function appPaths(): {
  dir: string;
  dest: string;
  apps: string;
  icons: string;
  desktopFile: string;
} {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const dir = process.env.ORCA_APPIMAGE_DIR ?? join(homedir(), "AppImages");
  return {
    dir,
    dest: join(dir, "orca.AppImage"),
    apps: join(dataHome, "applications"),
    icons: join(dataHome, "icons", "hicolor"),
    desktopFile: join(dataHome, "applications", `${DESKTOP_ID}.desktop`),
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

/**
 * Look up the latest release.
 *
 * Returns the tag, the AppImage's URL, its SHA-256 (if the release
 * publishes one) and the URL of the release's latest-linux.yml (if any).
 */
export async function releaseInfo(release: {
  tag_name?: string;
  assets?: { name?: string; browser_download_url?: string; digest?: string }[];
}): Promise<AppImageInfo> {
  const { asset, yml } = assetNames();
  const assets = new Map(
    (release.assets ?? []).map((a) => [a.name ?? "", a] as const),
  );
  const app = assets.get(asset);
  const ymlAsset = assets.get(yml);
  const digest = app?.digest ?? "";
  return {
    version: release.tag_name ?? "",
    url: app?.browser_download_url ?? "",
    sha256: digest.startsWith("sha256:") ? digest.slice("sha256:".length) : "",
    ymlUrl: ymlAsset?.browser_download_url ?? "",
  };
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
  const database = Bun.spawnSync(["which", "update-desktop-database"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (database.exitCode === 0) {
    Bun.spawnSync(["update-desktop-database", "-q", apps], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  for (const tool of ["kbuildsycoca6", "kbuildsycoca5"]) {
    const found = Bun.spawnSync(["which", tool], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (found.exitCode === 0) {
      Bun.spawnSync([tool], { stdout: "ignore", stderr: "ignore" });
      break;
    }
  }
}

/** Remove the app and its menu entry. */
export function removeApp(): void {
  const { dest, apps, icons, desktopFile } = appPaths();

  if (existsSync(desktopFile)) {
    const content = readFileSync(desktopFile, "utf8");
    if (!content.includes("X-Orca-Box=true")) {
      warn(`${desktopFile} wasn't created by orca-box; leaving it`);
    } else {
      Bun.spawnSync(["rm", "-f", desktopFile]);
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
  Bun.spawnSync(["rm", "-f", dest]);
  refreshMenus(apps);
  say(`Removed ${dest} and its menu entry (Orca's settings in ~/.config/orca are untouched).`);
}

/**
 * Write the .desktop file, from the one inside the AppImage.
 *
 * The AppImage's own .desktop file is the source of truth; we replace the
 * program with the path we installed it to, and point the icon at the one
 * we extracted.
 */
export function writeDesktopFile(
  embeddedPath: string,
  dest: string,
  icon: string,
  version: string,
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
  const quoted = `"${dest.replace(/([`$\\])/g, "\\$1")}"`;
  const result: string[] = [];
  for (let line of lines) {
    if (line.startsWith("[")) {
      // A new section.
    } else if (line.includes("=")) {
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1);
      if (key === "Exec") {
        // Replace the program (AppRun) with the installed AppImage; keep
        // its arguments.
        const parts = value.trim().split(/\s+/, 2);
        line = `Exec=${quoted}${parts.length > 1 ? ` ${parts[1]}` : " %U"}`;
      } else if (key === "TryExec" || key.startsWith("X-AppImage") || key === "X-Orca-Box") {
        continue;
      } else if (key === "Icon") {
        line = `Icon=${icon}`;
      }
    }
    result.push(line);
    if (line.trim() === "[Desktop Entry]") {
      result.push(`TryExec=${dest}`);
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

  const validate = Bun.spawnSync(["which", "desktop-file-validate"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (validate.exitCode === 0) {
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
