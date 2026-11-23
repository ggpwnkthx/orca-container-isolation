/**
 * Tests for orca-box.
 *
 * These run against a mock container engine and a mock Orca daemon, so
 * nothing here needs Podman, Docker or Orca installed.
 *
 *   bun test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, symlinkSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { sha512FromYml } from "../src/lib/appimage.ts";
import { assetNames } from "../src/lib/app.ts";
import { releaseInfo } from "../src/lib/release.ts";
import { invokeName, invokeNameFrom, psCmdlineName } from "../src/lib/invoke.ts";
import { hasCommand } from "../src/lib/which.ts";
import { hasSubidRange } from "../src/lib/setup.ts";
import { BoxLock } from "../src/lib/box.ts";
import { macAssetNames } from "../src/lib/macapp.ts";
import { isMac, isWindows, programAsset, programAssetUrl } from "../src/lib/platform.ts";
import { containerPath } from "../src/lib/hostpath.ts";

const MOCKS = join(import.meta.dir, "mocks");

/** A program that is on every system: sh on POSIX, cmd on Windows. */
const A_PROGRAM = isWindows() ? "cmd" : "sh";

let work: string;
let home: string;
let repo: string;
let bin: string;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "orca-box-test-"));
  home = join(work, "home");
  repo = join(work, "repo");
  bin = join(work, "bin");
  mkdirSync(bin, { recursive: true });
  // The mock engine is a program, so that it can be started the same way
  // on every platform: a .cmd file cannot be started without a shell.
  buildMock("podman", join(bin, mockName("podman")));
  buildMock("curl", join(bin, mockName("curl")));
  mkdirSync(join(home, ".agents", "skills", "demo"), { recursive: true });
  mkdirSync(join(home, ".claude", "skills"), { recursive: true });
  mkdirSync(join(home, ".config", "gh"), { recursive: true });
  // On Windows the GitHub CLI keeps its credentials under %APPDATA%.
  mkdirSync(join(home, "AppData", "Roaming", "GitHub CLI"), { recursive: true });
  writeFileSync(join(home, ".agents", "skills", "demo", "SKILL.md"), "skill\n");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", repo]);
  Bun.spawnSync(["git", "-C", repo, "config", "user.email", "test@example.com"]);
  Bun.spawnSync(["git", "-C", repo, "config", "user.name", "Test"]);
  Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "init"]);
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The name an executable has on this platform. */
function mockName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * Put a built program where the setup would put it.
 *
 * The program only behaves like the tool once it is installed: a copy
 * that is not installed sets itself up first.
 */
function installProgram(source: string): string {
  const dir = join(home, ".local", "share", "orca-box");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, "orca-box");
  copyFileSync(source, dest);
  chmodSync(dest, 0o755);
  return dest;
}

/** Build one of the mock programs into an executable. */
function buildMock(name: string, out: string): void {
  const built = Bun.spawnSync(
    [
      process.execPath,
      "build",
      "--compile",
      "--outfile",
      out,
      join(MOCKS, `${name}.ts`),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  if (built.exitCode !== 0) {
    throw new Error(`couldn't build the ${name} mock`);
  }
}

/** Run the program with the mock engine, capturing the engine's log. */
function run(args: string[], env: Record<string, string> = {}): {
  output: string;
  log: string;
  code: number;
  path: string;
} {
  const log = join(work, "engine.log");
  writeFileSync(log, "");
  const path = `${bin}${delimiter}${process.env.PATH ?? ""}`;
  const proc = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...args],
    {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        // Windows asks for the home folder under another name.
        USERPROFILE: home,
        HOMEDRIVE: "",
        HOMEPATH: "",
        // And for the settings and the app data under others.
        XDG_CONFIG_HOME: join(home, ".config"),
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        PATH: path,
        FAKE_LOG: log,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    output: `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`,
    log: readFileSync(log, "utf8"),
    code: proc.exitCode ?? 0,
    path,
  };
}

describe("the agent image", () => {
  test("the Containerfile is embedded and complete", async () => {
    const { containerfile } = await import("../src/assets/skill-sync.ts");
    const text = containerfile();
    expect(text).toContain("FROM docker.io/library/node");
    expect(text).toContain("@anthropic-ai/claude-code");
    expect(text).toContain("@openai/codex");
    expect(text).toContain("pi-coding-agent");
  });

  test("the GitHub CLI comes from a repository, not a tarball", async () => {
    // A tarball has to be fetched for the right architecture, which means
    // detecting the architecture and keeping a checksum per architecture.
    // The official apt repository has one package per architecture and apt
    // picks the right one, so there is nothing to detect.
    const { containerfile } = await import("../src/assets/skill-sync.ts");
    const text = containerfile();
    expect(text).toContain("cli.github.com/packages");
    expect(text).toContain("signed-by=");
    expect(text).not.toMatch(/linux_(amd64|arm64)/);
    expect(text).not.toMatch(/uname -m/);
  });

  test("the skill-sync script lists the skill folders", async () => {
    const { skillSyncScript } = await import("../src/assets/skill-sync.ts");
    const script = skillSyncScript();
    expect(script).toContain(".agents/skills");
    expect(script).toContain(".claude/skills");
    expect(script).toContain(".codex/skills");
    expect(script).toContain(".pi/agent/skills");
    // A bash heredoc's body has no trailing newline; match that exactly.
    expect(script.endsWith("\n")).toBe(false);
  });
});

describe("the release lookup", () => {
  test("it reads the tag, URL and digest", async () => {
    const info = await releaseInfo(
      {
        tag_name: "v1.2.3",
        assets: [
          {
            name: "orca-linux.AppImage",
            browser_download_url: "https://example/orca-linux.AppImage",
            digest: "sha256:abc123",
          },
          { name: "latest-linux.yml", browser_download_url: "https://example/latest-linux.yml" },
        ],
      },
      { asset: "orca-linux.AppImage", yml: "latest-linux.yml" },
    );
    expect(info.version).toBe("v1.2.3");
    expect(info.url).toBe("https://example/orca-linux.AppImage");
    expect(info.sha256).toBe("abc123");
    expect(info.ymlUrl).toBe("https://example/latest-linux.yml");
  });

  test("it copes with a release that publishes no digest", async () => {
    const info = await releaseInfo(
      {
        tag_name: "v1.0.0",
        assets: [{ name: "orca-linux.AppImage", browser_download_url: "https://example/a" }],
      },
      { asset: "orca-linux.AppImage", yml: "latest-linux.yml" },
    );
    expect(info.sha256).toBe("");
  });

  test("it picks the asset for this architecture", () => {
    const { asset } = assetNames();
    if (isMac()) {
      expect(asset).toMatch(/^orca-macos-(x64|arm64)\.dmg$/);
    } else if (isWindows()) {
      expect(asset).toBe("orca-windows-setup.exe");
    } else {
      expect(asset).toMatch(/^orca-linux(-arm64)?\.AppImage$/);
    }
  });
});

describe("the checksum from latest-linux.yml", () => {
  test("it finds the sha512 of the asset", () => {
    const yml = [
      "version: 1.0.0",
      "files:",
      "  - url: other.AppImage",
      "    sha512: OTHERHASH",
      "  - url: orca-linux.AppImage",
      "    sha512: WANTEDHASH",
      "  - url: third.AppImage",
      "    sha512: THIRDHASH",
    ].join("\n");
    expect(sha512FromYml(yml, "orca-linux.AppImage")).toBe("WANTEDHASH");
  });

  test("it returns nothing when the asset is not listed", () => {
    const yml = "files:\n  - url: other.AppImage\n    sha512: OTHERHASH\n";
    expect(sha512FromYml(yml, "orca-linux.AppImage")).toBe("");
  });
});

/**
 * The worktree as the program sees it.
 *
 * Git gives the path, with the real name of every folder (on Windows
 * the temporary folder may be named in the short form, RUNNER~1, and
 * git writes the long one) and with forward slashes.
 */
function worktreePath(): string {
  const top = Bun.spawnSync(
    ["git", "-C", repo, "rev-parse", "--show-toplevel"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const out = new TextDecoder().decode(top.stdout).trim();
  return (out || repo).replace(/\\/g, "/");
}

/**
 * The .git directory, as the program sees it.
 *
 * Git gives this one too, with forward slashes; the folders inside it
 * are then joined the way the system writes them.
 */
function gitCommonDir(): string {
  const dir = Bun.spawnSync(
    ["git", "-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
  );
  const out = new TextDecoder().decode(dir.stdout).trim();
  return out || `${worktreePath()}/.git`;
}

/** Where the GitHub CLI keeps its credentials, as the program looks for them. */
function ghDir(): string {
  if (isWindows()) return join(home, "AppData", "Roaming", "GitHub CLI");
  return join(home, ".config", "gh");
}

/**
 * The engine's log, and what the program said.
 *
 * Both are looked at, so that a failure says why the engine was not
 * called: the program usually explains itself on stderr.
 */
function engineLog(result: {
  log: string;
  output: string;
  code: number;
  path: string;
}): string {
  let mocks = "";
  try {
    mocks = readdirSync(bin).join(", ");
  } catch {
    mocks = "(none)";
  }
  return `${result.log}\n(exit ${result.code})\nPATH ${result.path}\nmocks: ${mocks}\n${result.output}`;
}

describe("running a box", () => {
  test("it runs the agent in the workspace's box", () => {
    // The box is made here, so the log says which worktree it is for.
    const result = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(engineLog(result)).toContain("PODMAN exec -i");
    expect(engineLog(result)).toContain(worktreePath());
  });

  test("an existing box is reused, not recreated", () => {
    const { log } = run(["orca-box", "claude"]);
    expect(log).not.toContain("PODMAN run -d");
  });

  test("the container drops all capabilities", () => {
    const result = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(engineLog(result)).toContain("--cap-drop=all");
    expect(engineLog(result)).toContain("--security-opt no-new-privileges");
  });

  test("the .git directory is read-only by default", () => {
    const result = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    const gitDir = gitCommonDir();
    expect(engineLog(result)).toContain(`-v ${gitDir}:${containerPath(gitDir)}:ro`);
  });

  test("rw mode makes .git writable but keeps hooks read-only", () => {
    const result = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GIT: "rw",
    });
    const gitDir = gitCommonDir();
    // The folders inside .git are joined the way the system writes them.
    const hooks = join(gitDir, "hooks");
    const config = join(gitDir, "config");
    expect(engineLog(result)).toContain(`-v ${gitDir}:${containerPath(gitDir)}`);
    expect(engineLog(result)).toContain(`-v ${hooks}:${containerPath(hooks)}:ro`);
    expect(engineLog(result)).toContain(`-v ${config}:${containerPath(config)}:ro`);
    expect(engineLog(result)).toContain("GIT_CONFIG_KEY_1=maintenance.auto");
  });

  test("the host's skills are mounted read-only", () => {
    const result = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    // The host side of the mount is the path as the system writes it.
    const skills = join(home, ".agents/skills");
    expect(engineLog(result)).toContain(`-v ${skills}:${containerPath(skills)}:ro`);
  });

  test("ORCA_BOX_SKILLS=0 turns the skill mounts off", () => {
    const { log } = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_SKILLS: "0",
    });
    expect(log).not.toContain(".agents/skills");
  });

  test("the gh credentials are only mounted when asked for", () => {
    const without = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(without.log).not.toContain(ghDir());

    const with_ = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
    });
    expect(engineLog(with_)).toContain(`${ghDir()}:/home/node/.config/gh:ro`);
  });

  test("an invalid ORCA_BOX_GIT is rejected", () => {
    const { output, code } = run(["orca-box", "claude"], { ORCA_BOX_GIT: "maybe" });
    expect(output).toContain("ORCA_BOX_GIT must be ro or rw");
    expect(code).toBe(2);
  });
});

describe("the command line", () => {
  test("every tool prints its usage", () => {
    for (const tool of [
      "orca-box",
      "orca-box-archive",
      "orca-box-login",
      "orca-box-configure-orca",
      "orca-box-install-orca",
      "orca-box-update",
      "orca-box-setup",
    ]) {
      const { output } = run([tool, "--help"]);
      expect(output).toContain(tool);
    }
  });

  test("an unknown option is rejected", () => {
    const { output, code } = run(["orca-box-update", "--nope"]);
    expect(output).toContain("unknown option");
    expect(code).toBe(2);
  });

  test("orca-box with no arguments says how to use it", () => {
    const { output, code } = run(["orca-box"]);
    expect(output).toContain("usage: orca-box <agent>");
    expect(code).toBe(2);
  });
});

describe("talking to Orca", () => {
  // Windows has no unix sockets: Orca publishes a named pipe there, and
  // the mock daemon cannot make one.
  test.skipIf(isWindows())("it points the agents at orca-box, and puts them back", async () => {
    // Start the mock Orca daemon.
    const dataDir = join(work, "orca-data");
    const sock = join(work, "orca.sock");
    const daemon = Bun.spawn(
      [process.execPath, join(import.meta.dir, "mocks", "orca-daemon.ts"), dataDir, sock],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      for (let i = 0; i < 50; i++) {
        if (existsSync(sock)) break;
        await Bun.sleep(100);
      }
      expect(existsSync(sock)).toBe(true);

      // Run the real command against it, twice: set, then unset.
      const saved = join(work, "saved.json");
      const run = (args: string[]) =>
        Bun.spawnSync(
          [
            process.execPath,
            join(import.meta.dir, "..", "src", "main.ts"),
            "orca-box-configure-orca",
            ...args,
          ],
          {
            env: {
              ...process.env,
              HOME: home,
              ORCA_USER_DATA_PATH: dataDir,
              XDG_CONFIG_HOME: join(work, "config"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );

      const set = run([]);
      const setOut = new TextDecoder().decode(set.stdout);
      expect(setOut).toContain("orca-box claude");
      expect(setOut).toContain("orca-box codex");
      expect(setOut).toContain("orca-box pi");

      // The command codex had before is remembered, so --unset restores it.
      const unset = run(["--unset"]);
      const unsetOut = new TextDecoder().decode(unset.stdout);
      expect(unsetOut).toContain("codex --yolo");
    } finally {
      daemon.kill();
    }
  });
});

describe("the platforms", () => {
  test("the release asset is named after the machine", () => {
    const asset = programAsset();
    if (isMac()) {
      expect(asset).toMatch(/^orca-box-darwin-(x64|arm64)$/);
    } else if (isWindows()) {
      expect(asset).toMatch(/^orca-box-windows-x64$/);
    } else {
      expect(asset).toMatch(/^orca-box-linux-(x64|arm64)$/);
    }
    expect(programAssetUrl()).toContain(asset);
  });

  test("the Orca app asset is one for this platform", () => {
    const { asset } = assetNames();
    if (isMac()) {
      expect(asset).toMatch(/^orca-macos-(x64|arm64)\.dmg$/);
    } else if (isWindows()) {
      expect(asset).toBe("orca-windows-setup.exe");
    } else {
      expect(asset).toMatch(/^orca-linux(-arm64)?\.AppImage$/);
    }
  });

  test("the macOS assets are the disk images the release publishes", () => {
    const { asset, yml } = macAssetNames();
    expect(asset).toMatch(/^orca-macos-(x64|arm64)\.dmg$/);
    expect(yml).toMatch(/^latest-mac(-arm64)?\.yml$/);
  });
});

describe("the lock on the box", () => {
  test("it is taken and given back", async () => {
    const dir = join(work, "locks");
    mkdirSync(dir, { recursive: true });
    const lock = new BoxLock(dir, "demo");
    expect(await lock.acquire(5)).toBe(true);
    lock.release();
  });

  test("it works without flock, with a lock file of its own", async () => {
    // macOS has no flock; the lock file takes over there.
    const dir = join(work, "locks-noflock");
    mkdirSync(dir, { recursive: true });
    const saved = process.env.PATH;
    try {
      process.env.PATH = join(work, "empty-path");
      mkdirSync(join(work, "empty-path"), { recursive: true });
      const lock = new BoxLock(dir, "demo");
      expect(await lock.acquire(5)).toBe(true);
      expect(existsSync(lock.file)).toBe(true);
      lock.release();
      expect(existsSync(lock.file)).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });
});

describe("finding programs on PATH", () => {
  test("it finds a program that is there", () => {
    // sh is in every POSIX system; cmd is in every Windows one.
    expect(hasCommand(A_PROGRAM)).toBe(true);
  });

  test("it does not find a program that isn't", () => {
    expect(hasCommand("orca-box-not-a-real-program")).toBe(false);
  });

  test("it does not need `which` to be installed", () => {
    // The point of doing it ourselves: `which` isn't on every system.
    const saved = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent";
      expect(hasCommand(A_PROGRAM)).toBe(false);
    } finally {
      process.env.PATH = saved;
    }
  });

  test("a directory is not a program", () => {
    expect(hasCommand("/tmp")).toBe(false);
  });
});

describe("the subordinate id ranges", () => {
  test("it reads /etc/subuid and /etc/subgid", () => {
    // Both are name:start:count lines. Whatever this machine has, the
    // answers must be booleans and must agree with the files.
    const uid = process.getuid?.() ?? -1;
    const subuid = hasSubidRange("subuid");
    const subgid = hasSubidRange("subgid");
    expect(typeof subuid).toBe("boolean");
    expect(typeof subgid).toBe("boolean");

    // macOS has no subordinate ids: the virtual machine maps them.
    if (!existsSync("/etc/subuid")) {
      expect(subuid).toBe(false);
      expect(subgid).toBe(false);
      return;
    }

    // If the file names our uid, the range has to be there.
    const text = readFileSync("/etc/subuid", "utf8");
    const hasOurs = text
      .split("\n")
      .some((line) => {
        const [name, , count] = line.split(":");
        return count && Number(count) > 0 && Number(name) === uid;
      });
    if (hasOurs) expect(subuid).toBe(true);
  });
});

describe("the invocation name", () => {
  // Windows has no links: the commands are .cmd files that name the
  // command in the environment, which the other tests cover.
  test.skipIf(isWindows())("it is the name the process was called by, so symlinks work", () => {
    // The name comes from /proc/self/cmdline, which is what the kernel saw:
    // a link named orca-box-archive keeps that name, even though the
    // runtime resolves argv[1] to the real file.
    const bin = join(work, "bin");
    mkdirSync(bin, { recursive: true });

    // The real program, built if it isn't there yet: a link named
    // orca-box-archive must dispatch to the archive command.
    const built = join(work, "orca-box-bin");
    if (!existsSync(built)) {
      Bun.spawnSync([
        process.execPath,
        "build",
        "--compile",
        "--outfile",
        built,
        join(import.meta.dir, "..", "src", "main.ts"),
      ]);
    }
    // Installed, as the setup puts it: a copy that is not installed would
    // set itself up first.
    const installed = installProgram(built);
    const link = join(bin, "orca-box-archive");
    if (!existsSync(link)) symlinkSync(installed, link);

    // Run through the link: the name it was called by survives.
    const proc = Bun.spawnSync([link, "--help"], {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new TextDecoder().decode(proc.stdout);
    expect(output).toContain("orca-box-archive");
    expect(output).toContain("remove agent boxes right away");
  });

  test("it is this process's own name", () => {
    // Under bun test, the process was called "bun".
    expect(invokeName()).toBe(invokeName(process.argv[1]));
  });

  test.skipIf(isWindows())("the name can be read from ps, as macOS needs", () => {
    // macOS has no /proc, so the name comes from `ps`. This is the same
    // call macOS makes, and it has to give the same answer.
    const name = psCmdlineName(process.pid);
    expect(name).not.toBeNull();
    expect(name).toBe(invokeName());
  });
});
