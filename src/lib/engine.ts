/**
 * The container engine: Podman if it works, otherwise Docker.
 *
 * Everything that talks to a container goes through here, so the rest of the
 * code never has to care which engine is in use.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_FILE_DIR, setting } from "./config.ts";
import { VERSION } from "./version.ts";
import { isMac, isWindows } from "./platform.ts";
import { die, warn } from "./output.ts";
import { findCommand, hasCommand } from "./which.ts";

export type EngineMode = "podman" | "docker" | "docker-rootless";

let mode: EngineMode | null = null;

/**
 * Can Podman be used on this platform?
 *
 * Not on Windows: the boxes mount the worktree at the path Docker Desktop
 * gives it and map the host user onto a Linux uid, and Podman's machine has
 * neither. Docker is the engine there.
 */
export function podmanSupported(): boolean {
  return !isWindows();
}

/** The engine binary: "podman" or "docker". */
export function engineBinary(): "podman" | "docker" {
  if (mode === null) initEngine();
  return mode === "podman" ? "podman" : "docker";
}

/** The full mode, including whether Docker is rootless. */
export function engineMode(): EngineMode {
  if (mode === null) initEngine();
  return mode as EngineMode;
}

/** True if the Docker daemon is running rootless. */
export function dockerIsRootless(): boolean {
  try {
    const out = runCaptured("docker", [
      "info",
      "--format",
      "{{json .SecurityOptions}}",
    ]);
    return out.includes("rootless");
  } catch {
    return false;
  }
}

function engineHelp(): void {
  const has = (bin: string) => hasCommand(bin);
  if (has("docker")) {
    if (isMac()) {
      process.stderr.write(
        "orca-box: Docker is installed but not usable. Start Docker Desktop\n" +
          "and wait for it to come up, or install Podman instead (brew install\n" +
          "podman && podman machine start).\n",
      );
      return;
    }
    if (isWindows()) {
      process.stderr.write(
        "orca-box: Docker is installed but not usable. Start Docker Desktop\n" +
          "and wait for it to come up.\n",
      );
      return;
    }
    process.stderr.write(
      "orca-box: Docker is installed but not usable by your user. Start it with\n" +
        "  sudo systemctl enable --now docker\n" +
        'and add yourself to the docker group (sudo usermod -aG docker "$USER", then\n' +
        "log out and back in), or install Podman instead.\n",
    );
  } else if (has("podman")) {
    if (isMac()) {
      process.stderr.write(
        "orca-box: podman is installed but 'podman info' fails; run\n" +
          "  podman machine start\n" +
          "and try again.\n",
      );
      return;
    }
    if (isWindows()) {
      process.stderr.write(
        "orca-box: podman is installed, but Podman is not supported on Windows.\n" +
          "Install Docker Desktop and try again.\n",
      );
      return;
    }
    process.stderr.write(
      "orca-box: podman is installed but 'podman info' fails; run it to see why.\n",
    );
  } else {
    if (isWindows()) {
      process.stderr.write(
        "orca-box: neither Podman nor Docker was found. Install Docker Desktop:\n" +
          "Podman is not supported on Windows.\n",
      );
      return;
    }
    process.stderr.write(
      isMac()
        ? "orca-box: neither Podman nor Docker was found. Install Docker Desktop,\n" +
            "or install Podman with Homebrew (brew install podman).\n"
        : "orca-box: neither Podman nor Docker was found. Install one of them.\n",
    );
  }
}

/**
 * Work out which engine to use and remember it.
 *
 * The choice is recorded in the config dir, so a later run uses the same one
 * (Docker's rootless-ness in particular cannot be re-detected reliably).
 */
export function initEngine(force = false): EngineMode {
  if (mode !== null && !force) return mode;

  const engineFile = join(CONFIG_FILE_DIR, "engine");
  let saved = "";
  if (existsSync(engineFile)) {
    try {
      saved = readFileSync(engineFile, "utf8").trim();
    } catch {
      saved = "";
    }
  }

  const wanted = process.env.ORCA_BOX_ENGINE ?? "";
  if (wanted) {
    if (wanted === "podman") {
      mode = "podman";
    } else if (wanted === "docker") {
      // Reuse the recorded rootless/rootful mode, else detect it.
      mode = saved.startsWith("docker") ? (saved as EngineMode) : dockerIsRootless() ? "docker-rootless" : "docker";
    } else {
      die("orca-box: ORCA_BOX_ENGINE must be podman or docker");
    }
  } else if (saved) {
    mode = saved as EngineMode;
  } else {
    mode = detectMode();
    if (!mode) {
      engineHelp();
      process.exit(1);
    }
  }

  if (mode === "podman" && !podmanSupported()) {
    die(
      "orca-box: Podman is not supported on Windows. The boxes use Docker\n" +
        "Desktop's path layout and Linux user ids, which Podman's machine does\n" +
        "not have. Install Docker Desktop and try again, or set\n" +
        "ORCA_BOX_ENGINE=docker.",
    );
  }

  const bin = engineBinary();
  if (!hasCommand(bin)) {
    die(
      `orca-box: ${bin} not found (recorded in ${engineFile}); rerun orca-box-setup`,
    );
  }
  return mode;
}

function detectMode(): EngineMode | null {
  // Podman is not supported on Windows: orca-box mounts the worktree at the
  // path Docker Desktop gives it and maps the host user onto a Linux uid,
  // and Podman's machine has neither. So only Docker is looked for there.
  if (podmanSupported() && commandWorks("podman", ["info"])) return "podman";
  if (commandWorks("docker", ["info"])) {
    return dockerIsRootless() ? "docker-rootless" : "docker";
  }
  return null;
}

/**
 * The programs to try for a name: its full path, and the name itself.
 *
 * Windows keeps the extension, and the system does not always add it
 * when a program is started by name, so both are tried.
 */
export function programs(bin: string): string[] {
  const full = findCommand(bin);
  return full && full !== bin ? [full, bin] : [bin];
}

/** Start a program, by its full path or by its name. */
export function spawnProgram(
  bin: string,
  args: string[],
  options: Parameters<typeof Bun.spawnSync>[1],
): ReturnType<typeof Bun.spawnSync> | null {
  let last: unknown = null;
  for (const candidate of programs(bin)) {
    try {
      return Bun.spawnSync([candidate, ...args], options);
    } catch (err) {
      last = err;
    }
  }
  if (last) throw last;
  return null;
}

/**
 * Start a program and wait for it, by its full path or by its name.
 *
 * `extraEnv` adds variables to the engine's own environment. The engine
 * passes a variable on to the container when it is named in its arguments
 * without a value (`-e NAME`), and it takes the value from its own
 * environment -- so this is how a token reaches the container without
 * being in the command line.
 */
export function spawnEngine(
  args: string[],
  options: Parameters<typeof Bun.spawn>[1],
  extraEnv?: Record<string, string>,
): Bun.Subprocess {
  const bin = engineBinary();
  // A variable set in this process's environment is not in the
  // environment the engine is started with, so the values are passed on
  // explicitly.
  const spawnOptions = extraEnv
    ? { ...options, env: { ...process.env, ...extraEnv } }
    : options;
  let last: unknown = null;
  for (const candidate of programs(bin)) {
    try {
      return Bun.spawn([candidate, ...args], spawnOptions);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

function commandWorks(bin: string, args: string[]): boolean {
  try {
    const proc = spawnProgram(bin, args, {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return proc ? proc.exitCode === 0 : false;
  } catch {
    return false;
  }
}

/** Record the engine in use, so later runs agree. */
export function rememberEngine(): void {
  mkdirSync(CONFIG_FILE_DIR, { recursive: true });
  writeFileSync(join(CONFIG_FILE_DIR, "engine"), `${engineMode()}\n`);
}

/**
 * Run an engine command, returning its output.
 *
 * The engine's stderr is passed through, so the user sees podman's own
 * error messages.
 */
export function runCaptured(bin: string, args: string[]): string {
  const proc = spawnProgram(bin, args, {
    stdout: "pipe",
    stderr: "inherit",
    stdin: "ignore",
  });
  return proc ? new TextDecoder().decode(proc.stdout) : "";
}

/**
 * Run an engine command, inheriting stdio, and return its exit status.
 *
 * Used for the long-running, interactive commands: the agent in the box,
 * the login shell. The child's stdin and stdout are the terminal itself.
 */
export function runInteractive(bin: string, args: string[]): number {
  const proc = Bun.spawnSync([bin, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return proc.exitCode ?? 0;
}

/** Run an engine command quietly, ignoring failures. */
export function runQuiet(bin: string, args: string[]): void {
  try {
    Bun.spawnSync([bin, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
  } catch {
    // The engine may not be there; the caller checks for that separately.
  }
}

/**
 * The user and security flags every container gets.
 *
 *   podman:          map your user onto the image's node user (UID 1000)
 *   docker:          run as your own UID/GID
 *   docker-rootless: container root *is* your user on the host; IS_SANDBOX=1
 *                    lets Claude Code skip permissions as root (undocumented)
 */
export function userArgs(): string[] {
  switch (engineMode()) {
    case "podman":
      return ["--userns=keep-id:uid=1000,gid=1000", "--user", "1000:1000"];
    case "docker":
      if (isWindows()) {
        // Windows has no user ids of its own. The files Docker Desktop
        // shares with the virtual machine belong to root in the container,
        // but everyone may write to them, so the agent runs as the image's
        // own user (the one that owns the home volume).
        return ["--user", "1000:1000"];
      }
      return ["--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`];
    case "docker-rootless":
      return ["--user", "0:0", "-e", "IS_SANDBOX=1"];
  }
}

/**
 * Make the shared home volume writable by the user the agents run as.
 *
 * Only Docker needs this, and only when that user isn't the image's
 * UID 1000.
 */
export function prepareHome(): void {
  const volume = setting("ORCA_BOX_HOME_VOLUME");
  let owner: string;
  switch (engineMode()) {
    case "docker":
      if (isWindows()) {
        // The home volume keeps the ownership the image gives it, which is
        // the user the agents run as.
        return;
      }
      owner = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
      break;
    case "docker-rootless":
      owner = "0:0";
      break;
    default:
      return;
  }
  if (owner === "1000:1000") return;

  Bun.spawnSync(
    [
      engineBinary(),
      "run",
      "--rm",
      "--user",
      "0:0",
      "-v",
      `${volume}:/home/node`,
      setting("ORCA_BOX_IMAGE"),
      "sh",
      "-c",
      '[ "$(stat -c %u:%g /home/node)" = "$1" ] || chown -R "$1" /home/node',
      "_",
      owner,
    ],
    { stdout: "ignore", stderr: "ignore", stdin: "ignore" },
  );
}

/**
 * The mount option for a bind mount: "ro" or "rw".
 *
 * SELinux relabeling ("z") is added on hosts that have SELinux. macOS has
 * no SELinux, so nothing is added there.
 */
export function mountOpt(mode: "ro" | "rw"): string {
  let opts = mode === "ro" ? "ro" : "";
  if (existsSync("/sys/fs/selinux/enforce")) {
    opts = opts ? `${opts},z` : "z";
  }
  return opts ? `:${opts}` : "";
}

/**
 * The security options every box gets.
 *
 * no-new-privileges keeps a setuid program in the box from giving itself
 * more rights. Some container engines (older Docker Desktop versions on
 * macOS) don't know the option, so it can be turned off; the setup works
 * out whether the engine accepts it.
 */
export function securityArgs(): string[] {
  if (setting("ORCA_BOX_NO_NEW_PRIVILEGES") === "0") return [];
  return ["--security-opt", "no-new-privileges"];
}

/**
 * Can this engine run a container with no-new-privileges?
 *
 * The image has to be there to try it. When it isn't, the answer is
 * "yes, as far as we know": the engines on Linux all take the option,
 * and it is only some Docker Desktop versions on macOS that don't.
 */
export function engineSupportsNoNewPrivileges(): boolean {
  const image = setting("ORCA_BOX_IMAGE");
  if (!image) return true;
  const probe = Bun.spawnSync(
    [
      engineBinary(),
      "run",
      "--rm",
      "--security-opt",
      "no-new-privileges",
      image,
      "true",
    ],
    { stdout: "ignore", stderr: "pipe", stdin: "ignore" },
  );
  if (probe.exitCode === 0) return true;
  const err = new TextDecoder().decode(probe.stderr ?? new Uint8Array());
  // Only the option itself means "not supported"; anything else (no such
  // image, no engine running) is a different problem.
  if (/no-new-privileges/i.test(err)) return false;
  return true;
}

/** The ids of every orca-box container, found by label or by image. */
export function boxIds(): string[] {
  const bin = engineBinary();
  const ids = new Set<string>();
  for (const args of [
    ["ps", "-aq", "--filter", "label=orca.worktree"],
    ["ps", "-aq", "--filter", `ancestor=${setting("ORCA_BOX_IMAGE")}`],
  ]) {
    try {
      for (const line of runCaptured(bin, args).split("\n")) {
        const id = line.trim();
        if (id) ids.add(id);
      }
    } catch {
      // A missing engine just means no boxes.
    }
  }
  return [...ids];
}

/** The worktree a container was created for, if any. */
export function worktreeOf(id: string): string {
  try {
    return runCaptured(engineBinary(), [
      "inspect",
      "-f",
      '{{index .Config.Labels "orca.worktree"}}',
      id,
    ]).trim();
  } catch {
    return "";
  }
}

/** A container's name, without the engine's leading slash. */
export function nameOf(id: string): string {
  let name = id;
  try {
    name = runCaptured(engineBinary(), ["inspect", "-f", "{{.Name}}", id]).trim();
  } catch {
    // Fall back to the id.
  }
  return name.replace(/^\//, "");
}

/** Build the agent image from a folder holding the Containerfile. */
export function buildImage(dir: string, update = false): void {
  const args = ["build", "-f", join(dir, "Containerfile"), "-t", setting("ORCA_BOX_IMAGE")];
  // Which orca-box built the image, in the image itself and in its
  // label: so that a box can be traced back to the program that made
  // it.
  args.push("--label", `orca.version=${VERSION}`);
  args.push("--build-arg", `ORCA_BOX_VERSION=${VERSION}`);
  // The browser layer is skipped when the setting is 0, for the images
  // that do not want a browser in them.
  args.push("--build-arg", `ORCA_BOX_BROWSER=${setting("ORCA_BOX_BROWSER")}`);
  if (update) {
    if (engineBinary() === "podman") args.push("--pull=always", "--no-cache");
    else args.push("--pull", "--no-cache");
  }
  args.push(dir);
  const proc = Bun.spawnSync([engineBinary(), ...args], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  if (proc.exitCode !== 0) {
    warn("the agent image could not be built; see the errors above");
  }
}
