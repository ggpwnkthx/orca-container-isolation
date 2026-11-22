/**
 * The box: a container per Orca workspace.
 *
 * The container sees the worktree, a shared home volume and the host's
 * skills. It cannot see the rest of the host. The .git directory is
 * read-only unless ORCA_BOX_GIT=rw.
 */

import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { FileSink } from "bun";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { setting } from "./config.ts";
import {
  boxIds,
  engineBinary,
  engineMode,
  initEngine,
  mountOpt,
  nameOf,
  prepareHome,
  runCaptured,
  runInteractive,
  securityArgs,
  userArgs,
  worktreeOf,
} from "./engine.ts";
import { skillSyncScript } from "../assets/skill-sync.ts";
import { isMac, isShareableOnMac, isWindows } from "./platform.ts";
import { containerPath } from "./hostpath.ts";
import { die, plain, warn } from "./output.ts";
import { hasCommand, runIfPresent } from "./which.ts";

/** The folders the agents read skills from, on the host and in the box. */
export const SKILL_DIRS = [".agents/skills", ".claude/skills", ".codex/skills", ".pi/agent/skills"];

export type GitMode = "ro" | "rw";

/** Which folder to give the box. */
export interface Target {
  /** The worktree, or "" for a throwaway box with no host files. */
  worktree: string;
  /** The repo's shared .git directory, if this is a git worktree. */
  common: string;
  /** Where we are, for the final `exec -w`. */
  here: string;
}

/**
 * Work out which folder to give the box.
 *
 *   git repo/worktree        -> that worktree (+ .git per ORCA_BOX_GIT)
 *   other folder under ~     -> that folder only (Orca folder workspaces)
 *   ~ itself, a ~/.dotdir, or anywhere outside ~ -> nothing: a throwaway box
 *     with no host files, enough for Orca's background checks
 */
export function resolveTarget(): Target {
  const here = process.cwd();
  const homeReal = realpathSync(homedir());
  let worktree = "";
  let common = "";

  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  if (top.exitCode === 0) {
    worktree = new TextDecoder().decode(top.stdout).trim();
    const dir = Bun.spawnSync(
      ["git", "-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    );
    common = new TextDecoder().decode(dir.stdout).trim();
  } else {
    const resolved = realpathSync(here);
    if (resolved === homeReal || resolved.startsWith(`${homeReal}/.`)) {
      worktree = "";
    } else if (resolved.startsWith(`${homeReal}/`)) {
      worktree = here;
    } else {
      worktree = "";
    }
  }
  return { worktree, common, here };
}

/**
 * The host's skills, mounted read-only.
 *
 * Each skill folder is mounted whole, at the path it has on the host, so the
 * box sees what the host has right now: a skill installed while the box
 * runs shows up in it, no restart needed.
 */
export function skillMounts(): { mounts: string[]; sync: string } {
  const mounts: string[] = [];
  if (setting("ORCA_BOX_SKILLS") === "0") return { mounts, sync: "" };

  const home = homedir();
  const ro = mountOpt("ro");
  for (const dir of SKILL_DIRS) {
    const src = join(home, dir);
    if (!existsSync(src)) {
      // The mount has to exist when the box starts: make the folder on the
      // host if its parent is there, so skills installed later still arrive.
      const parent = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : ".";
      if (!existsSync(join(home, parent))) continue;
      try {
        mkdirSync(src, { recursive: true });
      } catch {
        continue;
      }
    }
    mounts.push("-v", `${src}:${src}${ro}`);

    // A skill kept outside those folders (a link out of the shared store):
    // mount it where it belongs. Rare, and fixed when the box starts.
    let entries: string[] = [];
    try {
      entries = readdirSync(src);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry;
      // These can't be expressed in a -v argument.
      if (name.includes(":") || name.includes(",") || name.startsWith(".")) continue;
      const full = join(src, entry);
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (!statSync(real).isDirectory()) continue; // skills are folders
      if (real.startsWith(`${home}/`) && real.slice(home.length + 1).includes("/skills/")) {
        continue; // already mounted
      }
      mounts.push("-v", `${real}:/home/node/${dir}/${name}${ro}`);
    }
  }
  return { mounts, sync: skillSyncScript() };
}

/**
 * The gh credentials, if the user asked for them.
 *
 * The config folder is mounted read-only: an agent cannot add or change
 * credentials, but it can read the token in there, so this hands your
 * GitHub token to everyone who runs in the box.
 */
export function ghMounts(): { mounts: string[]; env: string[] } {
  const mounts: string[] = [];
  const env: string[] = [];
  if (setting("ORCA_BOX_GH_AUTH") !== "1") return { mounts, env };

  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const ghDir = process.env.GH_CONFIG_DIR ?? join(xdg, "gh");
  if (existsSync(ghDir)) {
    mounts.push("-v", `${ghDir}:/home/node/.config/gh${mountOpt("ro")}`);
  }
  // A token in the environment instead of in gh's config folder.
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    const value = process.env[name];
    if (value) env.push("-e", name);
  }
  return { mounts, env };
}

/** The .git mounts for the box, and the git environment that goes with them. */
export function gitMounts(
  target: Target,
  mode: GitMode,
): { mounts: string[]; env: string[] } {
  const mounts: string[] = [];
  const env: string[] = [];
  const { common, worktree } = target;
  const rw = mountOpt("rw");
  const ro = mountOpt("ro");

  if (!common) {
    // Not a git repo: just the folder.
  } else if (mode === "rw") {
    // Agents may stage and commit, so objects, refs, logs and this
    // worktree's own index/HEAD are writable. Read-only: everything git
    // could later be made to *execute* on the host, or that belongs to other
    // worktrees:
    //   hooks/, config (core.hooksPath, core.fsmonitor, filter drivers,
    //   aliases), info/ (attributes, grafts), refs/tags, other worktrees'
    //   folders, and this worktree's config.worktree when the repo uses them.
    const gitDir = runCaptured("git", [
      "-C",
      worktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    ]).trim();
    mounts.push("-v", `${common}:${common}${rw}`);
    for (const part of ["hooks", "config", "info", "refs/tags"]) {
      if (existsSync(join(common, part))) {
        mounts.push("-v", `${join(common, part)}:${join(common, part)}${ro}`);
      }
    }
    if (existsSync(join(common, "worktrees"))) {
      mounts.push("-v", `${join(common, "worktrees")}:${join(common, "worktrees")}${ro}`);
      if (gitDir !== common) {
        mounts.push("-v", `${gitDir}:${gitDir}${rw}`);
        const cfg = runCaptured("git", [
          "-C",
          worktree,
          "config",
          "--bool",
          "extensions.worktreeConfig",
        ]).trim();
        if (cfg === "true") {
          const worktreeConfig = join(gitDir, "config.worktree");
          if (!existsSync(worktreeConfig)) {
            Bun.spawnSync(["touch", worktreeConfig]);
          }
          mounts.push("-v", `${worktreeConfig}:${worktreeConfig}${ro}`);
        }
      }
    }
    // Commit as you: your global ~/.gitconfig isn't in the box.
    for (const key of ["name", "email"]) {
      const value = runCaptured("git", ["-C", worktree, "config", `user.${key}`]).trim();
      if (!value) continue;
      const upper = key.toUpperCase();
      env.push("-e", `GIT_AUTHOR_${upper}=${value}`, "-e", `GIT_COMMITTER_${upper}=${value}`);
    }
    // No automatic gc/maintenance: it would try to rewrite read-only parts.
    env.push(
      "-e",
      "GIT_CONFIG_COUNT=2",
      "-e",
      "GIT_CONFIG_KEY_0=gc.auto",
      "-e",
      "GIT_CONFIG_VALUE_0=0",
      "-e",
      "GIT_CONFIG_KEY_1=maintenance.auto",
      "-e",
      "GIT_CONFIG_VALUE_1=false",
    );
  } else {
    mounts.push("-v", `${common}:${common}${ro}`);
  }
  return { mounts, env };
}

/** The name of a box, derived from its worktree. */
export function boxName(worktree: string): string {
  const slug = worktree
    .split("/")
    .pop()!
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 40);
  const hash = createHash("sha1").update(worktree).digest("hex").slice(0, 8);
  return `orca-${slug}-${hash}`;
}

/**
 * The state of a box: "true 2 <git mode>" for a running one, anything
 * else for anything that needs (re)creating.
 */
export function boxState(name: string): string {
  try {
    return runCaptured(engineBinary(), [
      "inspect",
      "-f",
      '{{.State.Running}} {{index .Config.Labels "orca.box"}} {{index .Config.Labels "orca.git"}}',
      name,
    ]).trim();
  } catch {
    return "";
  }
}

/**
 * Only one launch may create the box: Orca often starts several agent
 * processes for one workspace at once.
 *
 * The lock is a real file lock, held by a helper process that we keep
 * alive: if we die, the helper dies too and the lock frees itself, so a
 * crashed launch cannot wedge the workspace.
 *
 * Linux has flock(2); macOS has lockf(2) instead, so the helper is
 * whichever of the two the system has. When neither is there, a lock
 * file of our own is used instead.
 */
export class BoxLock {
  readonly file: string;
  private proc: Bun.Subprocess | null = null;
  private writer: FileSink | null = null;

  constructor(dir: string, name: string) {
    this.file = join(dir, `${name}.lock`);
  }

  /** The folder the lock lives in, checked for safety. */
  static prepare(): string {
    const runtimeDir = process.env.XDG_RUNTIME_DIR;
    const dir =
      runtimeDir && existsSync(runtimeDir)
        ? join(runtimeDir, "orca-box")
        : join(tmpdir(), `orca-box-${process.getuid?.() ?? 0}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch {
      // It may already exist.
    }
    const st = lstatSync(dir);
    // Windows has no user ids of its own, so the folder there is only
    // checked for being a folder.
    const uid = process.getuid?.();
    if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
      die(`orca-box: lock folder ${dir} isn't a private folder of yours`);
    }
    return dir;
  }

  /**
   * Take the lock, waiting up to timeout seconds.
   *
   * Returns true if the lock was taken, false if we timed out.
   */
  async acquire(timeout: number): Promise<boolean> {
    // The helper holds the lock for as long as its stdin stays open.
    const proc = Bun.spawn(
      ["flock", "-x", "-w", String(timeout), this.file, "-c", "echo READY; cat > /dev/null"],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value ?? new Uint8Array());
    if (!text.includes("READY")) {
      // Timed out: the lock is held by someone else.
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
      return false;
    }
    this.proc = proc;
    this.writer = proc.stdin as FileSink;
    return true;
  }

  release(): void {
    if (!this.writer || !this.proc) return;
    // Closing stdin ends the helper's `cat`, which ends the flock.
    try {
      this.writer.end();
    } catch {
      // Already closed.
    }
    this.writer = null;
    this.proc = null;
  }
}

/**
 * The system program that takes an exclusive lock on a file.
 *
 * flock on Linux, lockf on macOS and the other BSDs. Both run a command
 * while they hold the lock and print READY when they have it.
 */
function lockHelper(timeout: number, file: string): { bin: string[]; args: string[] } | null {
  if (hasCommand("flock")) {
    return {
      bin: ["flock"],
      args: ["-x", "-w", String(timeout), file, "-c", "echo READY; cat > /dev/null"],
    };
  }
  if (hasCommand("lockf")) {
    // lockf (macOS, the BSDs) locks the file exclusively and runs the
    // command while it holds the lock. It needs the file to exist.
    try {
      writeFileSync(file, "");
    } catch {
      // It may already be there.
    }
    return {
      bin: ["lockf"],
      args: ["-t", String(timeout), file, "sh", "-c", "echo READY; cat > /dev/null"],
    };
  }
  return null;
}

/** Is the lock file still held by a process that is alive? */
function lockIsHeld(file: string): boolean {
  let pid = 0;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {
    return false;
  }
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but is not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * How to find out who holds the lock.
 *
 * /proc on Linux; on macOS the lock's own file says which process has
 * it.
 */
function lockHolderHint(file: string): string {
  if (isMac()) {
    return `cat ${file}   # the process id that holds the lock`;
  }
  return `ls -l /proc/[0-9]*/fd 2>/dev/null | grep -F '${file}'`;
}

/** The script that runs inside the box as its PID 1. */
export function watchdogScript(): string {
  return `
trap "exit 0" TERM INT
step=15; limit=$(( (IDLE_SECONDS + step - 1) / step )); idle=0
while :; do
  sleep "$step" & wait $!
  # Link in skills installed on the host since the box started: $1 is the
  # script, $2 the host home folder it reads them from.
  [ -n "$1" ] && bash -c "$1" _ "$2" >/dev/null 2>&1
  procs=(/proc/[0-9]*)
  if [ "\${#procs[@]}" -le 1 ]; then idle=$((idle + 1)); else idle=0; fi
  [ "$idle" -ge "$limit" ] && exit 0
done`;
}

/**
 * Run an agent in the workspace's box.
 *
 * The box is created on first launch, reused by every later agent in the
 * same worktree, and deletes itself after ORCA_BOX_IDLE_SECONDS with
 * nothing running in it.
 */
export async function runAgent(args: string[]): Promise<void> {
  const gitMode = setting("ORCA_BOX_GIT") as GitMode;
  if (gitMode !== "ro" && gitMode !== "rw") {
    // The bash version prints this without the "error:" prefix.
    process.stderr.write("orca-box: ORCA_BOX_GIT must be ro or rw\n");
    process.exit(2);
  }
  const memory = process.env.ORCA_BOX_MEMORY ?? "8g";
  const idleSeconds = Number(setting("ORCA_BOX_IDLE_SECONDS"));
  const image = setting("ORCA_BOX_IMAGE");

  if (args.length === 0) {
    // The bash version prints this without the "error:" prefix.
    process.stderr.write("usage: orca-box <agent> [args...]\n");
    process.exit(2);
  }

  initEngine();

  // Orca runs the agent command in two ways: in a terminal tab
  // (interactive), and in the background for model lists, chat and commit
  // messages, where it talks to the agent as JSON over plain pipes. Only
  // ask for a terminal when we have one, or that JSON gets mangled.
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const io = interactive
    ? ["-it", "-e", `TERM=${process.env.TERM ?? "xterm-256color"}`, "-e", `COLORTERM=${process.env.COLORTERM ?? "truecolor"}`]
    : ["-i"];

  // ORCA_BOX_MEMORY= (empty) drops the limits, for hosts without cgroup
  // delegation (some rootless Docker setups refuse them).
  const limits =
    memory === "" ? [] : ["--pids-limit", "4096", "--memory", memory];

  // Remove boxes whose worktree no longer exists (deleted workspaces).
  // Only the labelled ones: the bash version uses the label filter here.
  for (const id of runCaptured(engineBinary(), [
    "ps",
    "-aq",
    "--filter",
    "label=orca.worktree",
  ])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const path = worktreeOf(id);
    if (path && !existsSync(path)) {
      Bun.spawnSync([engineBinary(), "rm", "-f", id], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
    }
  }

  const target = resolveTarget();
  if (target.worktree && !isShareableOnMac(target.worktree)) {
    warn(
      `${target.worktree} is in a folder Docker Desktop doesn't share with its virtual\n` +
        "    machine, so the box can't mount it. Move the worktree into your home\n" +
        "    folder, /Volumes or /tmp, or share the folder in Docker Desktop's\n" +
        "    settings (File → Settings → Resources → File sharing).",
    );
  }
  const skills = skillMounts();
  const skillSync = skills.sync;
  const gh = ghMounts();

  // Options every box gets: the agent's user, no capabilities, and the
  // shared home volume.
  const common = [
    ...userArgs(),
    "--cap-drop=all",
    ...securityArgs(),
    ...limits,
    "-v",
    `${setting("ORCA_BOX_HOME_VOLUME")}:/home/node`,
    "-e",
    "HOME=/home/node",
  ];

  if (!target.worktree) {
    prepareHome();
    const proc = Bun.spawn(
      [
        engineBinary(),
        "run",
        "--rm",
        ...io,
        "--label",
        "orca.scratch=1",
        ...common,
        "-w",
        "/home/node",
        ...skills.mounts,
        ...gh.mounts,
        ...gh.env,
        image,
        "bash",
        "-c",
        'bash -c "$1" _ "$2" >/dev/null 2>&1; shift 2; exec "$@"',
        "_",
        skillSync,
        homedir(),
        ...args,
      ],
      { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
    );
    process.exit(await proc.exited);
  }

  const name = boxName(target.worktree);
  const lockDir = BoxLock.prepare();
  const lock = new BoxLock(lockDir, name);
  const lockTimeout = Number(process.env.ORCA_BOX_LOCK_TIMEOUT ?? 60);

  let state = boxState(name);
  let needCreate = false;

  if (!state.startsWith("true 2 ")) {
    // Not running: only one launch may create it.
    const got = await lock.acquire(lockTimeout);
    if (!got) {
      // The other launch may have finished while we waited.
      state = boxState(name);
      if (!state.startsWith("true 2 ")) {
        die(
          `orca-box: timed out after ${lockTimeout}s waiting for another launch in this workspace.\n` +
            `orca-box: what holds the lock: ${lockHolderHint(lock.file)}`,
        );
      }
    } else {
      try {
        // Another launch may have made it while we waited.
        state = boxState(name);
        if (!state.startsWith("true 2 ")) {
          if (state) {
            Bun.spawnSync([engineBinary(), "rm", "-f", name], {
              stdout: "ignore",
              stderr: "ignore",
              stdin: "ignore",
            });
          }
          state = "";
          needCreate = true;
        }
      } finally {
        lock.release();
      }
    }
  }

  if (needCreate) {
    const mounts = [`-v`, `${target.worktree}:${target.worktree}${mountOpt("rw")}`];
    const git = gitMounts(target, gitMode);
    mounts.push(...git.mounts);
    prepareHome();
    const proc = Bun.spawn(
      [
        engineBinary(),
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "--label",
        `orca.worktree=${target.worktree}`,
        "--label",
        "orca.box=2",
        "--label",
        `orca.git=${gitMode}`,
        ...common,
        ...skills.mounts,
        ...gh.mounts,
        ...gh.env,
        ...mounts,
        "-w",
        target.worktree,
        "-e",
        `IDLE_SECONDS=${idleSeconds}`,
        ...git.env,
        image,
        "bash",
        "-c",
        watchdogScript(),
        "_",
        skillSync,
        homedir(),
      ],
      { stdout: "ignore", stderr: "inherit", stdin: "ignore" },
    );
    if ((await proc.exited) !== 0) {
      die("orca-box: could not create the box");
    }
  }

  if (state && state !== "" && state !== `true 2 ${gitMode}`) {
    // Agents may be running in it; don't pull the box out from under them.
    process.stderr.write(
      `orca-box: this workspace's box was started with ORCA_BOX_GIT=${state.slice(state.lastIndexOf(" ") + 1)}.\n`,
    );
    process.stderr.write(
      `orca-box: the new setting (${gitMode}) applies once the box goes idle, or run orca-box-archive here.\n`,
    );
  }

  // Skills installed on the host since this box started: link them in now,
  // so the agent sees them without waiting for the box's next sweep.
  if (skillSync) {
    Bun.spawnSync(
      [engineBinary(), "exec", name, "bash", "-c", skillSync, "_", homedir()],
      { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
    );
  }

  const proc = Bun.spawn(
    [engineBinary(), "exec", ...io, "-w", target.here, name, ...args],
    { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );
  process.exit(await proc.exited);
}

/** Remove the boxes, now or all of them. */
export function archive(all: boolean): void {
  const remove = (id: string): void => {
    plain(`removing ${nameOf(id)}`);
    Bun.spawnSync([engineBinary(), "rm", "-f", id], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
  };

  if (all) {
    for (const id of boxIds()) remove(id);
    return;
  }

  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: "ignore",
  });
  const worktree =
    top.exitCode === 0 ? new TextDecoder().decode(top.stdout).trim() : process.cwd();

  for (const id of boxIds()) {
    const path = worktreeOf(id);
    if (!path || path === worktree || !existsSync(path)) {
      remove(id);
    }
  }
}

/** Open a shell in the box, to sign in to the agents. */
export async function login(args: string[]): Promise<void> {
  prepareHome();
  const proc = Bun.spawn(
    [
      engineBinary(),
      "run",
      "--rm",
      "-it",
      "--network=host",
      ...userArgs(),
      "--cap-drop=all",
      "--security-opt",
      "no-new-privileges",
      "-v",
      `${setting("ORCA_BOX_HOME_VOLUME")}:/home/node`,
      "-e",
      "HOME=/home/node",
      "-w",
      "/home/node",
      "-e",
      `TERM=${process.env.TERM ?? "xterm-256color"}`,
      setting("ORCA_BOX_IMAGE"),
      ...(args.length ? args : ["bash"]),
    ],
    { stdout: "inherit", stderr: "inherit", stdin: "inherit" },
  );
  process.exit(await proc.exited);
}
