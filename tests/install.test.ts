/**
 * Where the installer puts its files.
 *
 * The program has to land where the platform expects it: on Windows
 * under %LOCALAPPDATA%\orca-box, with the commands in a bin folder
 * beside it, so that a command started by name is the same program the
 * README says it is. These tests install into a folder of their own and
 * look at what is on disk afterwards, so a change that puts a file
 * somewhere else is caught here rather than by whoever installs it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "../src/lib/command.ts";
import { installFiles } from "../src/lib/setup.ts";
import { paths, type Paths } from "../src/lib/paths.ts";

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

/** A folder of its own, to install into. */
function scratch(): { dir: string; source: string; target: Paths } {
  const dir = mkdtempSync(join(tmpdir(), "orca-box-install-"));
  const source = join(dir, "source-program");
  writeFileSync(source, "the program\n");
  // The layout the installer uses on Windows: the program in
  // %LOCALAPPDATA%\orca-box, the commands in a bin folder beside it.
  const data = join(dir, "Local", "orca-box");
  const target: Paths = {
    data,
    bin: join(data, "bin"),
    program: join(data, "orca-box.exe"),
    containerfile: join(data, "Containerfile"),
    chromium: join(data, "chromium.sh"),
  };
  return { dir, source, target };
}

describe("the installed files", () => {
  test("on Windows the commands are .cmd files in the bin folder", () => {
    pretendWindows();
    const { dir, source, target } = scratch();
    try {
      // An older version wrote the commands without the .cmd
      // extension, and cmd.exe cannot start those: they are taken away.
      mkdirSync(target.bin, { recursive: true });
      writeFileSync(join(target.bin, "orca-box-update"), "old\n");

      installFiles(target, source);

      // The program is the .exe, in the program's own folder.
      expect(existsSync(target.program)).toBe(true);
      expect(readFileSync(target.program, "utf8")).toBe("the program\n");

      // Every command is a .cmd file that says which command it is and
      // then runs the program.
      for (const tool of TOOLS) {
        const shim = join(target.bin, `${tool}.cmd`);
        expect(existsSync(shim)).toBe(true);
        const text = readFileSync(shim, "utf8");
        expect(text).toContain(`set "ORCA_BOX_TOOL=${tool}"`);
        expect(text).toContain(`"${target.program}" %*`);
      }

      // Nothing else is in the bin folder: no links, no copies.
      expect(readdirSync(target.bin).sort()).toEqual(
        TOOLS.map((tool) => `${tool}.cmd`).sort(),
      );

      // The two files the box needs are beside the program.
      expect(existsSync(target.containerfile)).toBe(true);
      expect(existsSync(target.chromium)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "on Linux and macOS the commands are links to the program",
    () => {
      const { dir, source, target } = scratch();
      try {
        installFiles(target, source);

        expect(existsSync(target.program)).toBe(true);
        for (const tool of TOOLS) {
          const link = join(target.bin, tool);
          expect(lstatSync(link).isSymbolicLink()).toBe(true);
          expect(readlinkSync(link)).toBe(target.program);
        }
        expect(readdirSync(target.bin).sort()).toEqual([...TOOLS].sort());
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("on a Windows machine", () => {
  test.skipIf(process.platform !== "win32")(
    "the files are installed where Windows expects them",
    () => {
      const local = process.env.LOCALAPPDATA;
      if (!local) throw new Error("LOCALAPPDATA is not set");

      // The folders the program says it uses, without a PREFIX and
      // without the XDG variables: the runner sets those, and they win
      // over the platform's own folders. What is left is what Windows
      // itself says: %LOCALAPPDATA%\orca-box for the program, and a bin
      // folder beside it for the commands.
      const saved = {
        prefix: process.env.PREFIX,
        config: process.env.XDG_CONFIG_HOME,
        data: process.env.XDG_DATA_HOME,
      };
      delete process.env.PREFIX;
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.XDG_DATA_HOME;

      const expected = windowsFolders(local, local);

      const dir = mkdtempSync(join(tmpdir(), "orca-box-win-install-"));
      let target: Paths | undefined;
      try {
        // The program's own idea of where it lives is the same one.
        const own = paths();
        expect(own.data).toBe(expected.data);
        expect(own.bin).toBe(expected.bin);
        expect(own.program).toBe(expected.program);

        // The install is done in the real folder when that folder is
        // free, so that the files are looked at where Windows puts
        // them. A folder that is already there belongs to whoever is
        // running the tests, so it is left alone.
        target = existsSync(expected.data)
          ? windowsFolders(local, dir)
          : expected;
        // The real program, so that the commands can be run afterwards.
        const source = buildProgram(dir);
        installFiles(target, source);

        // The program is where it says it is.
        expect(existsSync(target.program)).toBe(true);

        // The commands are .cmd files, one for each command.
        expect(readdirSync(target.bin).sort()).toEqual(
          TOOLS.map((tool) => `${tool}.cmd`).sort(),
        );
        for (const tool of TOOLS) {
          const shim = join(target.bin, `${tool}.cmd`);
          expect(existsSync(shim)).toBe(true);
          const text = readFileSync(shim, "utf8");
          expect(text).toContain(`set "ORCA_BOX_TOOL=${tool}"`);
          expect(text).toContain(`"${target.program}" %*`);
        }

        // The two files the box needs are beside the program.
        expect(existsSync(target.containerfile)).toBe(true);
        expect(existsSync(target.chromium)).toBe(true);

        // And a command started from the bin folder is the command it
        // says it is: the .cmd file runs the program.
        const shim = join(target.bin, "orca-box-update.cmd");
        const proc = Bun.spawnSync(
          [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `& '${shim}' --help`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
        const output = new TextDecoder().decode(proc.stdout);
        expect(output).toContain("orca-box-update");
      } finally {
        if (saved.prefix !== undefined) process.env.PREFIX = saved.prefix;
        if (saved.config !== undefined) process.env.XDG_CONFIG_HOME = saved.config;
        if (saved.data !== undefined) process.env.XDG_DATA_HOME = saved.data;
        rmSync(dir, { recursive: true, force: true });
        // Only what this test put there.
        if (target) rmSync(target.data, { recursive: true, force: true });
      }
    },
  );
});

/**
 * The folders the program uses on Windows.
 *
 * The program itself goes in the root folder, and the commands go in a
 * bin folder beside it.
 */
function windowsFolders(local: string, root: string): Paths {
  const data = join(root, "orca-box");
  return {
    data,
    bin: join(data, "bin"),
    program: join(data, "orca-box.exe"),
    containerfile: join(data, "Containerfile"),
    chromium: join(data, "chromium.sh"),
  };
}

/**
 * The program to install: the one the CI built, or one built here.
 *
 * The commands are run afterwards, so this has to be the real program
 * and not a file with the right name.
 */
function buildProgram(dir: string): string {
  const built = join(import.meta.dir, "..", "dist", "orca-box-windows-x64.exe");
  if (existsSync(built)) return built;
  const out = join(dir, "orca-box.exe");
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--outfile",
      out,
      join(import.meta.dir, "..", "src", "main.ts"),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) {
    throw new Error("couldn't build the program");
  }
  return out;
}
