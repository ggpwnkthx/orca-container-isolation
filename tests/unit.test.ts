/**
 * Tests for orca-box.
 *
 * These run against a mock container engine and a mock Orca daemon, so
 * nothing here needs Podman, Docker or Orca installed.
 *
 *   bun test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, chmodSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha512FromYml } from "../src/lib/appimage.ts";
import { assetNames } from "../src/lib/app.ts";
import { releaseInfo } from "../src/lib/release.ts";
import { invokeName, invokeNameFrom, psCmdlineName } from "../src/lib/invoke.ts";
import { hasCommand } from "../src/lib/which.ts";
import { hasSubidRange } from "../src/lib/setup.ts";
import { BoxLock } from "../src/lib/box.ts";
import { macAssetNames } from "../src/lib/macapp.ts";
import { isMac, programAsset, programAssetUrl } from "../src/lib/platform.ts";

const MOCKS = join(import.meta.dir, "mocks");

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
} {
  const log = join(work, "engine.log");
  writeFileSync(log, "");
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
        PATH: `${bin}:${process.env.PATH ?? ""}`,
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
    expect(asset).toMatch(/^orca-linux(-arm64)?\.AppImage$/);
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

describe("running a box", () => {
  test("it runs the agent in the workspace's box", () => {
    const { log } = run(["orca-box", "claude"]);
    expect(log).toContain("PODMAN exec -i");
    expect(log).toContain(repo);
  });

  test("an existing box is reused, not recreated", () => {
    const { log } = run(["orca-box", "claude"]);
    expect(log).not.toContain("PODMAN run -d");
  });

  test("the container drops all capabilities", () => {
    const { log } = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(log).toContain("--cap-drop=all");
    expect(log).toContain("--security-opt no-new-privileges");
  });

  test("the .git directory is read-only by default", () => {
    const { log } = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(log).toContain(`-v ${repo}/.git:${repo}/.git:ro`);
  });

  test("rw mode makes .git writable but keeps hooks read-only", () => {
    const { log } = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GIT: "rw",
    });
    expect(log).toContain(`-v ${repo}/.git:${repo}/.git`);
    expect(log).toContain(`-v ${repo}/.git/hooks:${repo}/.git/hooks:ro`);
    expect(log).toContain(`-v ${repo}/.git/config:${repo}/.git/config:ro`);
    expect(log).toContain("GIT_CONFIG_KEY_1=maintenance.auto");
  });

  test("the host's skills are mounted read-only", () => {
    const { log } = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(log).toContain(`${home}/.agents/skills:${home}/.agents/skills:ro`);
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
    expect(without.log).not.toContain("/home/node/.config/gh");

    const with_ = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
    });
    expect(with_.log).toContain("/home/node/.config/gh:ro");
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
  test("it points the agents at orca-box, and puts them back", async () => {
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
    } else {
      expect(asset).toMatch(/^orca-box-linux-(x64|arm64)$/);
    }
    expect(programAssetUrl()).toContain(asset);
  });

  test("the Orca app asset is one for this platform", () => {
    const { asset } = assetNames();
    if (isMac()) {
      expect(asset).toMatch(/^orca-macos-(x64|arm64)\.dmg$/);
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
    // sh is in every POSIX system.
    expect(hasCommand("sh")).toBe(true);
  });

  test("it does not find a program that isn't", () => {
    expect(hasCommand("orca-box-not-a-real-program")).toBe(false);
  });

  test("it does not need `which` to be installed", () => {
    // The point of doing it ourselves: `which` isn't on every system.
    const saved = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent";
      expect(hasCommand("sh")).toBe(false);
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
  test("it is the name the process was called by, so symlinks work", () => {
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

  test("the name can be read from ps, as macOS needs", () => {
    // macOS has no /proc, so the name comes from `ps`. This is the same
    // call macOS makes, and it has to give the same answer.
    const name = psCmdlineName(process.pid);
    expect(name).not.toBeNull();
    expect(name).toBe(invokeName());
  });
});
