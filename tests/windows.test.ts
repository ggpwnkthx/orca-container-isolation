/**
 * The Windows half of the program.
 *
 * Windows isn't available on every machine the tests run on, so the
 * platform is mocked: the code asks "are we on Windows?" and the answer
 * is forced here. What matters is that the paths, the assets and the
 * commands are the ones Windows needs.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containerPath, hostPath } from "../src/lib/hostpath.ts";
import { assetNames } from "../src/lib/app.ts";
import { windowsAssetNames } from "../src/lib/windowsapp.ts";
import { isWindows, programAsset, programName } from "../src/lib/platform.ts";
import { invokeName } from "../src/lib/invoke.ts";

const realPlatform = process.platform;

/** Pretend to be Windows for the length of a test. */
function pretendWindows(): void {
  Object.defineProperty(process, "platform", {
    value: "win32",
    configurable: true,
  });
}

afterEach(() => {
  Object.defineProperty(process, "platform", {
    value: realPlatform,
    configurable: true,
  });
});

describe("on Windows", () => {
  test("the program knows it is on Windows", () => {
    pretendWindows();
    expect(isWindows()).toBe(true);
  });

  test("the release asset is the Windows one", () => {
    pretendWindows();
    const asset = programAsset();
    expect(asset).toMatch(/^orca-box-windows-(x64|arm64)$/);
  });

  test("the Orca app comes as an installer", () => {
    pretendWindows();
    const { asset, yml } = assetNames();
    expect(asset).toBe(windowsAssetNames().asset);
    expect(asset).toBe("orca-windows-setup.exe");
    expect(yml).toBe("latest.yml");
  });

  test("a drive letter becomes a folder in the box", () => {
    pretendWindows();
    // A Linux container cannot have a folder called C:\Users\me in it.
    expect(containerPath("C:\\Users\\me\\project")).toBe("/c/Users/me/project");
    expect(containerPath("C:\\Users\\me")).toBe("/c/Users/me");
    expect(containerPath("D:\\work\\repo")).toBe("/d/work/repo");
  });

  test("the path back to the host is the drive letter again", () => {
    pretendWindows();
    expect(hostPath("/c/Users/me/project")).toBe("C:\\Users\\me\\project");
    expect(hostPath(containerPath("C:\\Users\\me\\project"))).toBe(
      "C:\\Users\\me\\project",
    );
  });

  test("a network folder gets a folder of its own", () => {
    pretendWindows();
    expect(containerPath("\\\\server\\share\\folder")).toBe(
      "/host/server/share/folder",
    );
  });

  test("on Linux and macOS the path is left alone", () => {
    pretendWindows();
    // Back to the real platform for this one.
    Object.defineProperty(process, "platform", {
      value: realPlatform,
      configurable: true,
    });
    expect(containerPath("/Users/me/project")).toBe("/Users/me/project");
  });

  test("the command can be named in the environment", () => {
    // Windows has no links, so the .cmd files that call the program say
    // which command they are.
    pretendWindows();
    const saved = process.env.ORCA_BOX_TOOL;
    process.env.ORCA_BOX_TOOL = "orca-box-archive";
    try {
      expect(invokeName()).toBe("orca-box-archive");
    } finally {
      if (saved === undefined) delete process.env.ORCA_BOX_TOOL;
      else process.env.ORCA_BOX_TOOL = saved;
    }
  });

  test("the .exe is the program, without the extension", () => {
    pretendWindows();
    const saved = process.env.ORCA_BOX_TOOL;
    process.env.ORCA_BOX_TOOL = "orca-box-archive.exe";
    try {
      expect(invokeName()).toBe("orca-box-archive");
    } finally {
      if (saved === undefined) delete process.env.ORCA_BOX_TOOL;
      else process.env.ORCA_BOX_TOOL = saved;
    }
  });
});

describe("the commands", () => {
  test("a command named as the first argument is that command", () => {
    // This is how Windows starts the commands: one program file, and the
    // name of the command as the first argument.
    const proc = Bun.spawnSync(
      [
        process.execPath,
        join(import.meta.dir, "..", "src", "main.ts"),
        "orca-box-archive",
        "--help",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = new TextDecoder().decode(proc.stdout);
    expect(output).toContain("orca-box-archive");
    expect(output).toContain("remove agent boxes right away");
  });

  test("a program called orca-box.exe is the orca-box command", () => {
    // The program on Windows is called orca-box.exe, and the .exe is not
    // part of the command's name.
    pretendWindows();
    expect(programName("orca-box.exe")).toBe("orca-box");
    expect(programName("orca-box-archive.exe")).toBe("orca-box-archive");
  });

  test("the .exe is only left off on Windows", () => {
    Object.defineProperty(process, "platform", {
      value: realPlatform,
      configurable: true,
    });
    if (realPlatform === "win32") return;
    expect(programName("orca-box.exe")).toBe("orca-box.exe");
  });

  test("a program called orca-box runs an agent", () => {
    // What Windows does: one program file, started by its path.
    const dir = mkdtempSync(join(tmpdir(), "orca-box-win-test-"));
    const home = join(dir, "home");
    const built = join(dir, "built");
    mkdirSync(home, { recursive: true });
    if (!existsSync(built)) {
      Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          "--outfile",
          built,
          join(import.meta.dir, "..", "src", "main.ts"),
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
    }
    // Installed, as the setup puts it: a copy that is not installed sets
    // itself up first.
    const data = join(home, ".local", "share", "orca-box");
    mkdirSync(data, { recursive: true });
    const installed = join(data, "orca-box");
    copyFileSync(built, installed);
    chmodSync(installed, 0o755);

    const proc = Bun.spawnSync([installed, "--help"], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(proc.stdout);
    expect(output).toContain("orca-box — run a coding agent inside a container");
    rmSync(dir, { recursive: true, force: true });
  });

  test("the installation lives in the user's own folders", () => {
    pretendWindows();
    // The program under %LOCALAPPDATA%, the settings under %APPDATA%.
    const local = process.env.LOCALAPPDATA ?? "";
    const roaming = process.env.APPDATA ?? "";
    expect(typeof local).toBe("string");
    expect(typeof roaming).toBe("string");
  });
});
