/**
 * The macOS half of the program.
 *
 * macOS isn't available on every machine the tests run on, so the
 * platform is mocked: the code asks "are we on macOS?" and the answer is
 * forced here. What matters is that the macOS paths pick the right
 * assets, the right folders and the right names.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { appPaths, assetNames } from "../src/lib/app.ts";
import { macAppPaths, macAssetNames } from "../src/lib/macapp.ts";
import { isMac, programAsset, programAssetUrl } from "../src/lib/platform.ts";
import { userDataDir } from "../src/lib/orca.ts";

const realPlatform = process.platform;

/** Pretend to be macOS for the length of a test. */
function pretendMac(): void {
  Object.defineProperty(process, "platform", {
    value: "darwin",
    configurable: true,
  });
}

/** Pretend to be Linux for the length of a test. */
function pretendLinux(): void {
  Object.defineProperty(process, "platform", {
    value: "linux",
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

describe("on macOS", () => {
  test("the program knows it is on macOS", () => {
    pretendMac();
    expect(isMac()).toBe(true);
    pretendLinux();
    expect(isMac()).toBe(false);
  });

  test("the release asset is the macOS one", () => {
    pretendMac();
    const asset = programAsset();
    expect(asset).toMatch(/^orca-box-darwin-(x64|arm64)$/);
    expect(programAssetUrl()).toContain(asset);
  });

  test("the Orca app comes from the disk image", () => {
    pretendMac();
    const { asset, yml } = assetNames();
    expect(asset).toBe(macAssetNames().asset);
    expect(asset).toMatch(/^orca-macos-(x64|arm64)\.dmg$/);
    expect(yml).toMatch(/^latest-mac/);
  });

  test("the app is installed as a bundle in the user's Applications", () => {
    pretendMac();
    const paths = appPaths();
    expect(paths.dest).toBe(join(homedir(), "Applications", "Orca.app"));
    expect(macAppPaths().dir).toBe(join(homedir(), "Applications"));
    // There is no .desktop file on macOS: the bundle is the menu entry.
    expect(paths.desktopFile).toBe("");
  });

  test("Orca's own settings are looked for in the Library folder", () => {
    pretendMac();
    const saved = process.env.ORCA_USER_DATA_PATH;
    delete process.env.ORCA_USER_DATA_PATH;
    try {
      expect(userDataDir()).toBe(
        join(homedir(), "Library", "Application Support", "orca"),
      );
    } finally {
      if (saved !== undefined) process.env.ORCA_USER_DATA_PATH = saved;
    }
  });
});

describe("on Linux", () => {
  test("the app is an AppImage with a menu entry", () => {
    pretendLinux();
    const paths = appPaths();
    expect(paths.dest).toMatch(/\/orca\.AppImage$/);
    expect(paths.desktopFile).toMatch(/\.desktop$/);
    expect(assetNames().asset).toMatch(/\.AppImage$/);
  });
});
