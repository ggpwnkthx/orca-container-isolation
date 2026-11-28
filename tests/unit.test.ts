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
import { hasCommand, findCommand } from "../src/lib/which.ts";
import { findGh, ghSettingsHosts } from "../src/lib/gh.ts";
import { hasSubidRange, orcaCommandPrefix, quoteCommandPath } from "../src/lib/setup.ts";
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
/**
 * A PATH with the engine and git in it, and no gh.
 *
 * A desktop app -- Orca -- starts the program with a PATH of its own,
 * which is a short one: gh, which most people install somewhere else,
 * is not on it. The folder is what the program is given to find things
 * in, and gh is deliberately not in it.
 */
let noGhBin: string;

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
  buildMock("gh", join(bin, mockName("gh")));
  // The same engine, in a folder without gh in it.
  noGhBin = join(work, "bin-no-gh");
  mkdirSync(noGhBin, { recursive: true });
  copyFileSync(join(bin, mockName("podman")), join(noGhBin, mockName("podman")));
  chmodSync(join(noGhBin, mockName("podman")), 0o755);
  const git = findCommand("git");
  if (git) symlinkSync(git, join(noGhBin, "git"));
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
  envLog: string;
  code: number;
  path: string;
} {
  const log = join(work, "engine.log");
  const envLog = join(work, "engine-env.log");
  writeFileSync(log, "");
  writeFileSync(envLog, "");
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
        FAKE_ENV_LOG: envLog,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    output: `${new TextDecoder().decode(proc.stdout)}${new TextDecoder().decode(proc.stderr)}`,
    log: readFileSync(log, "utf8"),
    envLog: readFileSync(envLog, "utf8"),
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

  test("the image has a browser, and Playwright to drive it", async () => {
    const { containerfile } = await import("../src/assets/skill-sync.ts");
    const text = containerfile();
    // The browser comes from Debian, so the shared libraries it needs
    // come with it.
    expect(text).toContain("chromium");
    expect(text).toContain("fonts-");
    // Playwright, for the skills that drive a browser.
    expect(text).toContain("playwright");
    // The agents look for the browsers in the home folder, which is a
    // volume: a browser an agent installs there survives the box.
    expect(text).toContain("PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright");
    // The browser tools look for these.
    expect(text).toContain("IMPECCABLE_BROWSER=");
    expect(text).toContain("CHROME_PATH=");
    expect(text).toContain("PUPPETEER_EXECUTABLE_PATH=");
    // The user's own tools are on the PATH in every box.
    expect(text).toContain("PATH=/home/node/.local/bin");
  });

  test("the browser wrapper is embedded", async () => {
    const { chromiumWrapper } = await import("../src/assets/skill-sync.ts");
    const script = chromiumWrapper();
    // The box drops every capability, so Chromium's own sandbox cannot
    // start: the wrapper turns it off.
    expect(script).toContain("--no-sandbox");
    // Every run gets a profile of its own: the boxes share one home.
    expect(script).toContain("--user-data-dir");
    // Without a display, the browser takes screenshots.
    expect(script).toContain("--headless=new");
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
 * Put a hosts.yml in the test home, and return the way to take it away.
 *
 * The file is what says the host's gh has credentials to share. The
 * token is only in the file where gh has no credential store to keep it
 * in, which is Linux; elsewhere it is asked of gh.
 */
function writeHosts(host: string, token = ""): () => void {
  const dir = ghDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "hosts.yml");
  const oauth = token ? `    oauth_token: ${token}\n` : "";
  writeFileSync(file, `${host}:\n    user: test\n${oauth}    git_protocol: ssh\n`);
  return () => rmSync(file, { force: true });
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
  test("the mock engine runs", () => {
    // The program starts the engine by name; the mock has to work.
    const log = join(work, "mock.log");
    const proc = Bun.spawnSync([join(bin, mockName("podman")), "info"], {
      env: { ...process.env, FAKE_LOG: log },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(`exit ${proc.exitCode}\\n${new TextDecoder().decode(proc.stderr)}`).toBe(
      "exit 0\\n",
    );
    expect(readFileSync(log, "utf8")).toContain("PODMAN info");
  });

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

  test("a box Podman reports as running is replaced if crun says it is stopped", () => {
    const result = run(["orca-box", "pi", "--model", "test-model"], {
      FAKE_EXEC_FAILURE: "stale",
    });
    const actions = result.log
      .split("\n")
      .filter((line) => /^PODMAN (rm -f|run -d|exec -i) /.test(line))
      .map((line) => line.split(" ")[1]);
    expect(actions).toEqual(["rm", "run", "exec"]);
    expect(result.log).toContain(" pi --model test-model");
    expect(result.code).toBe(0);
  });

  test("an unrelated Podman exec failure leaves the existing box in place", () => {
    const { log, code } = run(["orca-box", "claude"], {
      FAKE_EXEC_FAILURE: "permission",
    });
    expect(log).not.toContain("PODMAN rm -f");
    expect(log).not.toContain("PODMAN run -d");
    expect(code).toBe(125);
  });

  test("the container drops all capabilities", () => {
    const result = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(engineLog(result)).toContain("--cap-drop=all");
    expect(engineLog(result)).toContain("--security-opt no-new-privileges");
  });

  test("the scratch folder is in the home folder, so it survives the box", () => {
    const result = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    // TMPDIR is in the home volume, not in the container's own
    // filesystem: /tmp goes when the box goes.
    expect(engineLog(result)).toContain("TMPDIR=/home/node/.tmp/");
    expect(engineLog(result)).not.toContain("TMPDIR=/tmp");
  });

  test("the box says what survives, for the agents in it", () => {
    const result = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(engineLog(result)).toContain(".orca-box.md");
    expect(engineLog(result)).toContain("ms-playwright");
  });

  test("the box says which orca-box made it", () => {
    const result = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    // A label on the box, so it can be traced back to the program that
    // made it, and a version in the environment, for the agent in it.
    expect(engineLog(result)).toContain("orca.version=");
    expect(engineLog(result)).toContain("-e ORCA_BOX_VERSION=");
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

    const hosts = writeHosts("github.com");
    try {
      const with_ = run(["orca-box", "claude"], {
        FAKE_EXISTING: "0",
        ORCA_BOX_GH_AUTH: "1",
      });
      expect(engineLog(with_)).toContain(`${ghDir()}:/home/node/.config/gh:ro`);
    } finally {
      hosts();
    }
  });

  test("a gh folder with no credentials in it is not mounted", () => {
    // An empty folder would hide the credentials a box wrote to the
    // shared home (orca-box-login), and the sign-in would be lost.
    const result = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
    });
    expect(result.log).not.toContain(ghDir());
  });

  test("the box says whether it was made with the gh credentials", () => {
    const without = run(["orca-box", "claude"], { FAKE_EXISTING: "0" });
    expect(without.log).toContain("orca.gh=0");

    const with_ = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
    });
    expect(with_.log).toContain("orca.gh=1");
  });

  test("the gh token is passed in the environment, not on the command line", () => {
    // On macOS and Windows gh keeps the token in the system credential
    // store, so it is not in the file that is mounted: it has to be
    // passed another way.
    const result = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
    });
    expect(result.log).toContain("-e GH_TOKEN");
    // The token is passed by name, so it is not in the command line,
    // where every process on the machine could read it.
    expect(result.log).not.toContain("gho_testtoken");
  });

  test("the gh token reaches the container", () => {
    // The engine takes the value of a variable it is given by name from
    // its own environment, so the token has to be in the environment the
    // engine is started with. A variable set in the program's own
    // environment is not: it has to be passed on.
    const result = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
    });
    expect(result.envLog).toContain("GH_TOKEN=gho_testtoken");
  });

  test("an enterprise host gets the token under the name gh looks for", () => {
    // gh ignores GH_TOKEN for an enterprise host: there it looks for
    // GITHUB_ENTERPRISE_TOKEN.
    const hosts = writeHosts("ghe.example.com");
    try {
      const result = run(["orca-box", "claude"], {
        FAKE_EXISTING: "0",
        ORCA_BOX_GH_AUTH: "1",
      });
      expect(result.log).toContain("-e GITHUB_ENTERPRISE_TOKEN");
      expect(result.envLog).toContain("GITHUB_ENTERPRISE_TOKEN=gho_testtoken");
      expect(result.envLog).toContain("GH_HOST=ghe.example.com");
    } finally {
      hosts();
    }
  });

  test("no token is passed when the host is not logged in", () => {
    const result = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
      FAKE_GH_TOKEN: "",
    });
    expect(result.log).not.toContain("-e GH_TOKEN");
  });

  test("the gh host is passed with the token", () => {
    // A GitHub Enterprise host: gh has to be told which one to use.
    const hosts = writeHosts("ghe.example.com");
    try {
      const result = run(["orca-box", "claude"], {
        FAKE_EXISTING: "0",
        ORCA_BOX_GH_AUTH: "1",
      });
      expect(result.log).toContain("-e GH_HOST");
    } finally {
      hosts();
    }
  });

  test("the token is captured with gh auth token, on the host", () => {
    // The token is in the system credential store on macOS and Windows,
    // and only the host's gh can read it: so the host's gh is asked, and
    // it is asked for the token of the host it is logged in to.
    const result = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
    });
    expect(result.log).toContain("GH auth token --hostname github.com");
    expect(result.envLog).toContain("GH_TOKEN=gho_testtoken");
  });

  test("the token is found without gh on the PATH", () => {
    // The program is usually started by a desktop app, whose PATH is a
    // short one, so gh is not on it: the token in the gh settings file
    // is used instead of asking gh.
    const hosts = writeHosts("github.com", "gho_fromthefile");
    try {
      const result = run(["orca-box", "claude"], {
        FAKE_EXISTING: "0",
        ORCA_BOX_GH_AUTH: "1",
        PATH: noGhBin,
      });
      expect(result.envLog).toContain("GH_TOKEN=gho_fromthefile");
      expect(result.envLog).toContain("GH_HOST=github.com");
    } finally {
      hosts();
    }
  });

  test("the host of the token in the settings file is passed on", () => {
    // An enterprise host: gh ignores GH_TOKEN there, so the token goes
    // under the name gh looks for.
    const hosts = writeHosts("ghe.example.com", "gho_fromthefile");
    try {
      const result = run(["orca-box", "claude"], {
        FAKE_EXISTING: "0",
        ORCA_BOX_GH_AUTH: "1",
        PATH: noGhBin,
      });
      expect(result.envLog).toContain("GITHUB_ENTERPRISE_TOKEN=gho_fromthefile");
      expect(result.envLog).toContain("GH_HOST=ghe.example.com");
    } finally {
      hosts();
    }
  });

  test("the box says when no token could be found", () => {
    // The host is not logged in, and there is no token to be had: say so,
    // rather than let the agent find an unauthenticated gh.
    const result = run(["orca-box", "claude"], {
      FAKE_EXISTING: "0",
      ORCA_BOX_GH_AUTH: "1",
      FAKE_GH_TOKEN: "",
    });
    expect(result.output).toContain("no GitHub token found");
    expect(result.output).toContain("orca-box-login");
  });

  test("a box made without the gh credentials says so", () => {
    // The credentials are a mount, so a box that is already running keeps
    // the mounts it was made with: say so, rather than let the agent
    // find an unauthenticated gh and wonder why.
    const result = run(["orca-box", "claude"], {
      FAKE_EXISTING: "1",
      FAKE_GH: "0",
      ORCA_BOX_GH_AUTH: "1",
    });
    expect(result.output).toContain("started without your gh credentials");
    expect(result.output).toContain("orca-box-archive");
  });

  test("an invalid ORCA_BOX_GIT is rejected", () => {
    const { output, code } = run(["orca-box", "claude"], { ORCA_BOX_GIT: "maybe" });
    expect(output).toContain("ORCA_BOX_GIT must be ro or rw");
    expect(code).toBe(2);
  });
});

describe("the host's gh settings", () => {
  test("the hosts and their tokens are read from the settings file", () => {
    const dir = join(work, "ghsettings");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "hosts.yml"),
      [
        "# the hosts this gh knows",
        "github.com:",
        "    user: test",
        "    oauth_token: gho_plain",
        "    git_protocol: https",
        "ghe.example.com:",
        "    user: other",
        "    users:",
        "        someone:",
        "            oauth_token: ghe_plain",
        "",
      ].join("\n"),
    );
    const before = process.env.GH_CONFIG_DIR;
    process.env.GH_CONFIG_DIR = dir;
    try {
      const hosts = ghSettingsHosts();
      expect(hosts.map((h) => h.host)).toEqual(["github.com", "ghe.example.com"]);
      expect(hosts[0]?.token).toBe("gho_plain");
      expect(hosts[1]?.token).toBe("ghe_plain");
    } finally {
      if (before === undefined) delete process.env.GH_CONFIG_DIR;
      else process.env.GH_CONFIG_DIR = before;
    }
  });

  test("gh is found where it is installed, not only on the PATH", () => {
    // GH_PATH is the variable gh itself uses to say where it is.
    const fake = join(work, "gh-in-a-folder");
    writeFileSync(fake, "#!/bin/sh\nexit 0\n");
    chmodSync(fake, 0o755);
    const before = process.env.GH_PATH;
    process.env.GH_PATH = fake;
    try {
      expect(findGh()).toBe(fake);
    } finally {
      if (before === undefined) delete process.env.GH_PATH;
      else process.env.GH_PATH = before;
    }
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
  /** Start the mock Orca daemon, and hand its socket to the caller. */
  async function withMockOrca(
    name: string,
    run: (
      run: (args: string[]) => ReturnType<typeof Bun.spawnSync>,
    ) => Promise<void>,
    env: Record<string, string> = {},
  ): Promise<void> {
    // Windows has no unix sockets: Orca publishes a named pipe there, and
    // the mock daemon cannot make one.
    if (isWindows()) return;
    // Its own socket and data folder per test: the daemon of the last
    // test may still be holding the old one.
    const dataDir = join(work, `orca-data-${name}`);
    const sock = join(work, `orca-${name}.sock`);
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

      await run((args: string[]) =>
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
              ...env,
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        ),
      );
    } finally {
      daemon.kill();
    }
  }

  test("it points the agents at orca-box, and puts them back", async () => {
    await withMockOrca("set", async (run) => {
      const set = run([]);
      const setOut = new TextDecoder().decode(set.stdout);
      expect(setOut).toContain("orca-box claude");
      expect(setOut).toContain("orca-box codex");
      expect(setOut).toContain("orca-box pi");

      // The command codex had before is remembered, so --unset restores it.
      const unset = run(["--unset"]);
      const unsetOut = new TextDecoder().decode(unset.stdout);
      expect(unsetOut).toContain("codex --yolo");
    });
  });

  test("yolo is set where Orca has a permission mode for the agent", async () => {
    await withMockOrca("yolo", async (run) => {
      const set = run(["--yolo"]);
      const setOut = new TextDecoder().decode(set.stdout);
      expect(setOut).toContain("claude  permissions: Yolo");
      expect(setOut).toContain("codex   permissions: Yolo");
      // Orca has no permission mode for pi, and refuses the change. That
      // is said, and it does not stop the other agents, or the command
      // for pi itself, from being set.
      expect(setOut).toContain("pi      permissions: left as they were");
      expect(setOut).toContain("orca-box pi");
      // The whole change is still a success.
      expect(set.exitCode).toBe(0);
    });
  });

  test("a path with a space in it is quoted, and is still ours", async () => {
    // Orca runs the command through a shell, so a path with a space in
    // it has to be quoted -- or the shell sees two words.
    const prefix = join(home, "my programs");
    await withMockOrca(
      "space",
      async (run) => {
        const set = run([]);
        const setOut = new TextDecoder().decode(set.stdout);
        expect(setOut).toContain(`'${join(prefix, "bin", "orca-box")}' claude`);

        // The quoted path is recognized as ours, so --unset puts back
        // what was there before.
        const unset = run(["--unset"]);
        const unsetOut = new TextDecoder().decode(unset.stdout);
        expect(unsetOut).toContain("(default)");
      },
      { PREFIX: prefix },
    );
  });
});

describe("the command Orca is given", () => {
  test("it is the bare name when the commands are in ~/.local/bin", () => {
    expect(orcaCommandPrefix()).toBe("orca-box");
  });

  test("a path with a space in it is quoted", () => {
    // Orca runs the command through a shell: without the quotes, the
    // shell would read it as two words.
    expect(quoteCommandPath("/home/me/my programs/orca-box")).toBe(
      "'/home/me/my programs/orca-box'",
    );
  });

  test("a path with a quote in it is quoted as well", () => {
    expect(quoteCommandPath("/home/me/it's here/orca-box")).toBe(
      "'/home/me/it'\\''s here/orca-box'",
    );
  });

  test("a path without a space in it is left as it is", () => {
    expect(quoteCommandPath("/home/me/bin/orca-box")).toBe(
      "/home/me/bin/orca-box",
    );
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
