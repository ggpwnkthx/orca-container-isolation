/**
 * Installing the Orca app on macOS.
 *
 * macOS isn't available on every machine the tests run on, so the disk
 * image is stood in for: a fake `hdiutil` puts a fake application bundle
 * where the real one would mount it, and the rest of the installer runs
 * as it would on a Mac.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { macAppPaths, removeMacApp } from "../src/lib/macapp.ts";

const MOCKS = join(import.meta.dir, "mocks");

let work: string;
let apps: string;
let image: string;
let bundle: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "orca-box-mac-"));
  apps = join(work, "Applications");
  bundle = join(work, "image", "Orca.app");

  // The bundle that is inside the disk image.
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist/>\n");
  writeFileSync(join(bundle, "Contents", "MacOS", "Orca"), "#!/bin/sh\n");

  // The disk image itself; its contents are never looked at.
  image = join(work, "orca-macos.dmg");
  writeFileSync(image, "not a real disk image");

  // A stand-in for hdiutil.
  const bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  const hdiutil = join(bin, "hdiutil");
  writeFileSync(
    hdiutil,
    `#!/bin/sh
# A stand-in for hdiutil: "attach" puts the fake image's contents in the
# mount point, "detach" does nothing.
case "$1" in
  attach)
    shift
    mount=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -mountpoint) mount="$2"; shift ;;
      esac
      shift
    done
    [ -n "$mount" ] || exit 1
    mkdir -p "$mount"
    cp -R "$FAKE_IMAGE_CONTENTS/." "$mount/"
    ;;
  detach) ;;
  *) exit 1 ;;
esac
exit 0
`,
  );
  chmodSync(hdiutil, 0o755);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Run the macOS installer with the stand-in tools on the PATH. */
function install(): { output: string; code: number } {
  const proc = Bun.spawnSync(
    [process.execPath, join(MOCKS, "mac-install.ts"), image],
    {
      env: {
        ...process.env,
        PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`,
        HOME: work,
        ORCA_APP_DIR: apps,
        XDG_DATA_HOME: join(work, "data"),
        FAKE_IMAGE_CONTENTS: join(work, "image"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    output: `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`,
    code: proc.exitCode ?? 0,
  };
}

describe("installing Orca on macOS", () => {
  test("the bundle ends up in the Applications folder", () => {
    const { output, code } = install();
    expect(code).toBe(0);
    expect(output).toContain("Installed");

    const dest = join(apps, "Orca.app");
    expect(existsSync(join(dest, "Contents", "MacOS", "Orca"))).toBe(true);
    expect(existsSync(join(dest, "Contents", "Info.plist"))).toBe(true);
  });

  test("it can be removed again", () => {
    const saved = process.env.ORCA_APP_DIR;
    process.env.ORCA_APP_DIR = apps;
    try {
      expect(existsSync(macAppPaths().dest)).toBe(true);
      removeMacApp();
      expect(existsSync(macAppPaths().dest)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ORCA_APP_DIR;
      else process.env.ORCA_APP_DIR = saved;
    }
  });
});
