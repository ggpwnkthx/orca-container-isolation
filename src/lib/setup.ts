/**
 * The installer: orca-box-setup.
 *
 * Sets up Orca with orca-box: the Orca app itself, plus one container per
 * Orca workspace for Claude Code, Codex and pi.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_DIR, setConfig, setting } from "./config.ts";
import { TOOLS } from "./command.ts";
import { appPaths, installOrcaApp, removeApp } from "./app.ts";
import { findWindowsOrca } from "./windowsapp.ts";
import {
  boxIds,
  buildImage,
  engineBinary,
  engineMode,
  engineSupportsNoNewPrivileges,
  initEngine,
  nameOf,
  rememberEngine,
  spawnProgram,
} from "./engine.ts";
import { containerfile } from "../assets/skill-sync.ts";
import { hostGhCredentials, hostGhState } from "./gh.ts";
import { configure, runningOrca, userDataDir } from "./orca.ts";
import { isLinux, isMac, isWindows } from "./platform.ts";
import { removeAutoUpdate } from "./update.ts";
import { paths } from "./paths.ts";
import { die, plain, say, warn } from "./output.ts";
import { findCommand, hasCommand, runIfPresent } from "./which.ts";

/** The commands this project installs, and the function behind each. */
export { TOOLS } from "./command.ts";
export type { Tool } from "./command.ts";

export interface SetupOptions {
  mode: "install" | "update" | "uninstall";
  purge: boolean;
  yolo: boolean;
  gitMode: string;
  ghAuth: boolean;
  installApp: boolean;
  appFrom: string;
  launch: boolean;
  changeOrca: boolean;
  build: boolean;
  keepBoxes: boolean;
  brief: boolean;
}

/**
 * Your login name.
 *
 * Read from /etc/passwd, matched by uid, rather than asked for: the
 * $USER environment variable isn't set under `su`, in some service
 * managers, or in a bare container, and the runtime's own lookup can fail
 * when the name service isn't reachable. macOS has no /etc/passwd, so the
 * name comes from the environment there.
 */
function currentUsername(): string {
  try {
    const uid = process.getuid?.() ?? -1;
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const parts = line.split(":");
      if (parts.length >= 3 && Number(parts[2]) === uid) return parts[0] ?? "";
    }
  } catch {
    // No passwd file to read.
  }
  const fromEnv = process.env.USER ?? process.env.LOGNAME ?? "";
  if (fromEnv) return fromEnv;
  // Last resort: ask the system.
  try {
    const proc = Bun.spawnSync(["id", "-un"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    return new TextDecoder().decode(proc.stdout).trim();
  } catch {
    return "";
  }
}

/**
 * Does your user have a range of subordinate ids in /etc/subuid or
 * /etc/subgid? Rootless Podman needs one to map your user into a
 * container.
 *
 * This is a Linux thing: macOS has no subordinate ids, because the
 * containers run in a virtual machine that maps them itself.
 */
export function hasSubidRange(file: "subuid" | "subgid"): boolean {
  if (!isLinux()) return false;
  const path = join("/etc", file);
  try {
    // The file is keyed by name on some systems and by uid on others, so
    // accept either.
    const user = currentUsername();
    const uid = process.getuid?.() ?? -1;
    return readFileSync(path, "utf8")
      .split("\n")
      .some((line) => {
        // The format is name:start:count.
        const [name, start, count] = line.split(":");
        if (!name || !start || !count) return false;
        if (name !== user && Number(name) !== uid) return false;
        return Number(count) > 0;
      });
  } catch {
    // No such file: no ranges.
    return false;
  }
}

/**
 * Podman, found on the PATH.
 */
function podmanBinary(): string {
  return findCommand("podman") || "podman";
}

/**
 * The command Orca should use to start an agent.
 *
 * Orca adds ~/.local/bin to its own PATH, so the bare name works for
 * terminal tabs and background jobs alike, and is the same on every
 * machine. A literal "~" would not work: Orca runs background jobs
 * without a shell. With a custom PREFIX, Orca can't find the bare name,
 * so use the full path.
 *
 * On Windows a .cmd file cannot be started without a shell, so the
 * program itself is named.
 */
export function orcaCommandPrefix(): string {
  const { bin, program } = paths();
  if (isWindows()) return program;
  const localBin = join(homedir(), ".local", "bin");
  if (bin !== localBin) {
    return join(bin, "orca-box");
  }
  return "orca-box";
}

/** Point Orca's agents at orca-box. */
async function configureOrca(yolo: boolean): Promise<boolean> {
  const { program } = paths();
  const saved = join(CONFIG_FILE_DIR, "orca-previous-commands.json");
  const prefix = orcaCommandPrefix();

  try {
    return await configure({
      action: "set",
      yolo,
      boxPath: program,
      savedPath: saved,
      prefix,
    });
  } catch (err) {
    warn(`couldn't reach Orca: ${(err as Error).message}`);
    return false;
  }
}

/** Remove orca-box: the scripts, the image and the containers. */
export async function uninstall(options: SetupOptions): Promise<void> {
  const { data, bin } = paths();
  const app = appPaths();

  if (options.changeOrca) {
    say("Resetting Orca's Claude Code, Codex and pi commands");
    try {
      await configure({
        action: "unset",
        yolo: false,
        boxPath: paths().program,
        savedPath: join(CONFIG_FILE_DIR, "orca-previous-commands.json"),
        prefix: "orca-box",
      });
    } catch {
      warn(
        "couldn't reach Orca; reset the agent commands in Settings → Agents yourself",
      );
    }
  }

  try {
    initEngine();
    say(`Removing orca-box containers (${engineBinary()})`);
    for (const id of boxIds()) {
      plain(`    ${nameOf(id)}`);
      spawnProgram(engineBinary(), ["rm", "-f", id], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    say(`Removing image ${setting("ORCA_BOX_IMAGE")}`);
    spawnProgram(engineBinary(), ["rmi", "-f", setting("ORCA_BOX_IMAGE")], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (options.purge) {
      say(`Deleting saved logins (volume ${setting("ORCA_BOX_HOME_VOLUME")})`);
      spawnProgram(engineBinary(), ["volume", "rm", "-f", setting("ORCA_BOX_HOME_VOLUME")], {
        stdout: "ignore",
        stderr: "ignore",
      });
    } else {
      plain(
        `    Saved logins kept in volume '${setting("ORCA_BOX_HOME_VOLUME")}' (use --uninstall --purge to delete).`,
      );
    }
  } catch {
    warn("no working container engine found; skipping containers, image and volume");
  }

  if (options.purge) {
    say(
      `Removing the Orca app and its menu entry (Orca's settings stay in ${userDataDir()})`,
    );
    removeApp();
  } else if (existsSync(app.dest)) {
    plain(
      `    The Orca app stays installed at ${app.dest} (use --uninstall --purge to remove it).`,
    );
  }

  say(`Removing scripts from ${bin} and settings`);
  if (isMac() || isWindows()) {
    // The daily update, if it was turned on.
    removeAutoUpdate();
  }
  for (const tool of [...TOOLS, "orca-box-lib.sh"]) {
    for (const name of isWindows() ? [tool, `${tool}.cmd`] : [tool]) {
      try {
        unlinkSync(join(bin, name));
      } catch {
        // Not there.
      }
    }
  }
  rmSync(data, { recursive: true, force: true });
  rmSync(CONFIG_FILE_DIR, { recursive: true, force: true });
  say(
    "Done. If you added orca-box custom agents or an Archive Script in Orca, remove them.",
  );
}

/** Install orca-box: the commands, the image and Orca's settings. */
export async function setup(options: SetupOptions): Promise<void> {
  const { data, bin, program, containerfile: containerfilePath } = paths();

  // --- checks -------------------------------------------------------------
  if (process.getuid?.() === 0) {
    die("run this as your normal user, not root or sudo");
  }
  // git is the only host program the box itself needs; the agents bring
  // their own runtimes, and everything else is optional and checked where
  // it is used.
  for (const tool of ["git"]) {
    if (!hasCommand(tool)) {
      die(`${tool} not found`);
    }
  }
  // --- 1. the Orca app ----------------------------------------------------
  if (options.installApp) {
    try {
      await installOrcaApp(options.appFrom);
    } catch (err) {
      die(
        `installing Orca failed (${(err as Error).message}). Download it from https://orca.dev and rerun with --orca-from FILE, or use --no-orca-app to skip this step.`,
      );
    }
  }

  // --- 2. container engine ------------------------------------------------
  // Pick the engine fresh (ignore any earlier recording) unless overridden.
  try {
    unlinkSync(join(CONFIG_FILE_DIR, "engine"));
  } catch {
    // Not there.
  }
  try {
    initEngine(true);
  } catch {
    die("no usable container engine (see above)");
  }

  switch (engineMode()) {
    case "podman": {
      const version = Bun.spawnSync([podmanBinary(), "version", "--format", "{{.Client.Version}}"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const ver = new TextDecoder().decode(version.stdout).trim() || "0";
      const [major = "0", minor = "0"] = ver.split(".");
      if (Number(major) < 4 || (Number(major) === 4 && Number(minor) < 3)) {
        die(
          `podman ${ver} is too old; need 4.3 or newer (or set ORCA_BOX_ENGINE=docker)`,
        );
      }
      say(`Using Podman ${ver} (rootless)`);

      if (isMac()) {
        // Podman on macOS runs the containers in a virtual machine. The
        // user mapping is done by the machine, so the Linux helpers and
        // subordinate ids aren't needed -- but the machine has to exist.
        plain("    Note: on macOS, Podman runs in a virtual machine (podman machine).");
        plain("    Docker Desktop is usually the smoother choice here.");
      }

      // Rootless Podman maps your user into the container with
      // --userns=keep-id, which needs the setuid helpers and a range of
      // subordinate ids. Some distributions ship Podman without them, and
      // the failure only shows up much later, as a box that won't start.
      if (isLinux() && !hasCommand("newuidmap")) {
        warn(
          "newuidmap isn't installed, so rootless Podman can't map your user into a box.\n" +
            "    Install it with your package manager: uidmap (Debian, Ubuntu),\n" +
            "    shadow-utils (Fedora), shadow (Arch), or use Docker instead.",
        );
      }
      if (isLinux() && (!hasSubidRange("subuid") || !hasSubidRange("subgid"))) {
        warn(
          "your user has no subuid/subgid range, so rootless Podman can't map\n" +
            "    your user into a box. Add one, or use Docker instead:\n" +
            `      sudo usermod --add-subuids \$(id -u)-65536 --add-subgids \$(id -g)-65536 $(id -un)`,
        );
      }
      break;
    }
    case "docker":
      say("Using Docker");
      plain("    Note: access to the Docker daemon is root-equivalent on this machine;");
      plain("    the boxes themselves still run as your user with no capabilities.");
      if (isMac()) {
        plain("    On macOS this is Docker Desktop: the containers run in a virtual");
        plain("    machine, and the worktree has to be in a folder Docker shares");
        plain("    (your home folder, /Volumes, /private or /tmp).");
      }
      break;
    case "docker-rootless":
      say("Using rootless Docker");
      plain("    Agents run as container root (your user on the host). Claude Code needs");
      plain("    IS_SANDBOX=1 to skip permissions as root; orca-box sets it.");
      break;
  }

  // --- 3. orca-box --------------------------------------------------------
  say(`Installing orca-box to ${program}, commands in ${bin}`);
  mkdirSync(bin, { recursive: true });
  mkdirSync(data, { recursive: true });
  mkdirSync(CONFIG_FILE_DIR, { recursive: true });

  // One copy of the program; every command is a link to it.
  installProgram(program);

  for (const tool of TOOLS) {
    const link = join(bin, tool);
    try {
      unlinkSync(link);
    } catch {
      // Not there.
    }
    if (isWindows()) {
      writeWindowsShim(link, program, tool);
    } else {
      symlinkSync(program, link);
    }
  }
  writeFileSync(containerfilePath, containerfile());
  rememberEngine();

  if (options.gitMode) {
    setConfig("ORCA_BOX_GIT", options.gitMode);
    if (options.gitMode === "rw") {
      say("Agents can stage and commit (hooks, git config and other worktrees stay read-only)");
    } else {
      say("Agents get a read-only .git; commit from Orca's source control tab");
    }
  }
  if (options.ghAuth) {
    setConfig("ORCA_BOX_GH_AUTH", "1");
    say(
      "Agents in the boxes can use your gh credentials (read-only; anyone in a box can read the token)",
    );
    // Say what there is to share, so an empty share is not a mystery.
    const host = hostGhState();
    const creds = hostGhCredentials();
    if (creds.token) {
      plain(`    Sharing your gh token (from ${creds.source}): it is passed in the`);
      plain("    environment, and your gh settings are mounted read-only.");
    } else if (host.hasConfig) {
      plain(`    Sharing ${join(host.dir, "hosts.yml")}.`);
      if (creds.reason) {
        plain(`    ${creds.reason}, so no token is passed to the boxes.`);
      }
    } else {
      plain("    There are no gh credentials on this host yet: there is no");
      plain(`    ${join(host.dir, "hosts.yml")} and no GH_TOKEN in the environment.`);
      plain("    Run gh auth login on the host, or sign in inside a box with");
      plain("    orca-box-login: the boxes share one home, so that login is shared too.");
    }
    plain("    Boxes that are already running keep the mounts they were made with;");
    plain("    run orca-box-archive to start them again.");
  }

  if (options.build) {
    if (options.mode === "update") {
      say(`Rebuilding ${setting("ORCA_BOX_IMAGE")} with the latest agent versions`);
      buildImage(data, true);
      if (!options.keepBoxes) {
        say("Removing running boxes so new launches use the new image");
        archiveAll();
      } else {
        say("Running boxes switch to the new image once they go idle");
      }
    } else {
      say(`Building ${setting("ORCA_BOX_IMAGE")} (first build takes a few minutes)`);
      buildImage(data);
    }
  }

  // Does the engine know --security-opt no-new-privileges? Older Docker
  // Desktop versions on macOS don't, and a box that can't start is worse
  // than one without that extra guard.
  if (setting("ORCA_BOX_NO_NEW_PRIVILEGES") !== "0" && !engineSupportsNoNewPrivileges()) {
    setConfig("ORCA_BOX_NO_NEW_PRIVILEGES", "0");
    warn(
      "this container engine doesn't accept --security-opt no-new-privileges;\n" +
        "    turning it off (the boxes still drop all capabilities and run as you)",
    );
  }

  const pathEntries = (process.env.PATH ?? "").split(":");
  if (!pathEntries.includes(bin)) {
    if (isWindows()) {
      // On Windows the commands are .cmd files, and they are only found
      // if their folder is on the PATH.
      if (addToUserPath(bin)) {
        say(`Added ${bin} to your PATH (open a new terminal to use it)`);
      } else {
        warn(`${bin} is not on your PATH; add it to use the commands by name`);
      }
    } else {
      warn(`${bin} is not on your PATH; Orca uses the full paths, so that's fine.`);
      if (isMac()) {
        plain(
          `    To run the commands by name, add this to your shell profile:\n      export PATH="$HOME/.local/bin:$PATH"`,
        );
      }
    }
  }

  // --- 4. Orca settings ----------------------------------------------------
  let orcaDone = false;
  let runningFrom = "";
  if (options.changeOrca) {
    let running = runningOrca();
    if (running.pid === 0 && options.launch && existsSync(appPaths().dest)) {
      say("Starting Orca to apply its settings");
      startApp(appPaths().dest);
      for (let i = 0; i < 90; i++) {
        await Bun.sleep(1000);
        running = runningOrca();
        if (running.pid !== 0) break;
      }
      if (running.pid === 0) warn("Orca didn't start within 90 seconds");
    }
    if (running.pid !== 0) {
      runningFrom = running.appimage;
      say("Pointing Orca's Claude Code, Codex and pi agents at orca-box");
      orcaDone = await configureOrca(options.yolo);
      if (!orcaDone) warn("Orca's settings weren't changed (see above).");
    }
  }

  if (options.brief) {
    say("orca-box installed");
    return;
  }

  printSummary(options, orcaDone, runningFrom);
}

/**
 * Add a folder to the user's PATH on Windows.
 *
 * The user's own PATH is changed, not the machine's, so nothing needs
 * administrator rights. It is read and written with .NET, which does not
 * truncate it the way `setx` does.
 */
function addToUserPath(dir: string): boolean {
  const script = [
    "$p = [Environment]::GetEnvironmentVariable('Path','User')",
    "if ($p -and $p.Split(';') -notcontains '${dir}') {",
    "  [Environment]::SetEnvironmentVariable('Path', $p + ';${dir}', 'User')",
    "}",
  ].join("; ");
  const done = runIfPresent("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  return done === 0;
}

/**
 * Write a command for Windows.
 *
 * Windows cannot run a program through a link without extra privileges,
 * and a .cmd file cannot be started by another program without a shell.
 * So the commands are small .cmd files that say which command they are
 * and then run the program; they are meant to be typed in a shell.
 */
function writeWindowsShim(shim: string, program: string, tool: string): void {
  writeFileSync(
    shim,
    [
      "@echo off",
      `set "ORCA_BOX_TOOL=${tool}"`,
      `"${program}" %*`,
      "",
    ].join("\r\n"),
  );
}

/** Remove every box. */
function archiveAll(): void {
  for (const id of boxIds()) {
    spawnProgram(engineBinary(), ["rm", "-f", id], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

/**
 * Start the Orca app, detached from this process.
 *
 * On Linux that is the AppImage, started with setsid so it outlives the
 * installer. On macOS it is an application bundle, started with `open`.
 */
export function startApp(app: string): void {
  if (isMac()) {
    runIfPresent("open", ["-a", app], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  if (isWindows()) {
    // Orca is an installed program; start the one that is installed.
    const installed = findWindowsOrca() || app;
    if (!installed) {
      warn("Orca isn't installed yet; install it and run orca-box-configure-orca");
      return;
    }
    Bun.spawnSync([installed], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    return;
  }
  runIfPresent("setsid", ["-f", app], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

/**
 * Put the program in place.
 *
 * When the program is running from a file, that file is the program. When
 * it is running from a compiled binary, the binary is copied.
 */
export function installProgram(dest: string): void {
  const source = currentProgram();
  if (!source) {
    die(
      "this is a source checkout, not a program that can be installed.\n" +
        "    Run ./build.sh and install the program it writes to dist/, or\n" +
        "    download the release for your platform.",
    );
  }
  if (source === dest) return;
  const tmp = `${dest}.${process.pid}.tmp`;
  copyFileSync(source, tmp);
  chmodSync(tmp, 0o755);
  // Windows will not replace a program that is running, but it will let
  // it be renamed: the old copy is moved out of the way first.
  const old = `${dest}.old`;
  try {
    renameSync(dest, old);
  } catch {
    // There was no old copy.
  }
  renameSync(tmp, dest);
  try {
    rmSync(old, { force: true });
  } catch {
    // It was still running; it goes when the program does.
  }
}

/**
 * The file this program is running from, if any.
 *
 * A compiled program: execPath is the executable itself. A program run
 * from source has no file to install, so it is not returned.
 */
export function currentProgram(): string {
  const fromArgv = process.argv[1];
  if (fromArgv && fromArgv.endsWith(".ts")) {
    // Running from source: there is no program to install.
    return "";
  }
  // A compiled program: execPath is the executable itself.
  const exec = process.execPath;
  if (exec && !exec.includes("bunfs") && existsSync(exec)) return exec;
  return "";
}

/** The installer's closing summary. */
function printSummary(
  options: SetupOptions,
  orcaDone: boolean,
  runningFrom: string,
): void {
  const { bin } = paths();
  const app = appPaths();
  const yoloFlag = options.yolo ? " --yolo" : "";

  plain();
  say("Installed.");
  plain();
  plain(" 1. " + appStep(options, app.dest, runningFrom));
  plain();
  plain(" 2. Sign in once (logins are shared by every box):");
  plain(`      ${join(bin, "orca-box-login")}`);
  plain("    then inside: claude (/login), codex login, pi (/login), exit");
  plain();
  plain(" 3. " + settingsStep(options, orcaDone, bin, yoloFlag));
  plain();
  plain(" 4. Optional, per repository in Orca: set the Archive Script to");
  plain(`      ${archiveCommand(bin)}`);
  plain("    (boxes also delete themselves after 2 minutes with nothing running).");
  plain();
  plain(" Update later with: orca-box-update  (add --agents --orca to refresh the");
  plain(" agent image and Orca too; --enable-auto to check daily)");
}

/**
 * The command that removes the boxes.
 *
 * On Windows a .cmd file cannot be started by another program without a
 * shell, so the program itself is named, with the command as its first
 * argument.
 */
function archiveCommand(bin: string): string {
  if (isWindows()) {
    return `"${paths().program}" orca-box-archive`;
  }
  return join(bin, "orca-box-archive");
}

function appStep(options: SetupOptions, dest: string, runningFrom: string): string {
  if (!options.installApp) return "Orca app: unchanged (--no-orca-app).";
  let text = isMac()
    ? `Orca app: ${dest}, in your Applications folder.`
    : isWindows()
      ? `Orca app: ${dest || "not installed yet"}.`
      : `Orca app: ${dest}, in your application menu as "Orca".`;
  text += "\n    Orca keeps itself updated; orca-box-setup --update reinstalls the latest.";
  if (runningFrom && runningFrom !== dest) {
    text += `\n    Orca is running from ${runningFrom} right now. Quit it and start`;
    text += "\n    Orca from the application menu to switch to the installed copy;";
    text += `\n    then you can delete ${runningFrom}.`;
  }
  return text;
}

function settingsStep(
  options: SetupOptions,
  orcaDone: boolean,
  bin: string,
  yoloFlag: string,
): string {
  if (orcaDone) {
    let text =
      "Done: Orca's built-in Claude Code, Codex and pi agents now launch\n    through orca-box (see Settings → Agents → Command).";
    if (!options.yolo) {
      text +=
        "\n    They still ask for permissions; to stop that, set them to Yolo in\n    Settings → Agents, or rerun with --yolo.";
    }
    return text;
  }
  return (
    `Start Orca, then run:  ${join(bin, "orca-box-configure-orca")}${yoloFlag}` +
    "\n    (or set each agent's Command in Settings → Agents to" +
    "\n    orca-box claude / codex / pi)" +
    `\n    Optional: add a custom agent '${join(bin, "orca-box")} bash' for a shell in the box.`
  );
}
