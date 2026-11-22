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
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_DIR, setConfig, setting } from "./config.ts";
import {
  appPaths,
  assetNames,
  fetchText,
  fetchToFile,
  installFallbackIcon,
  installIcons,
  releaseInfo,
  removeApp,
  sha256File,
  sha512FileBase64,
  sha512FromYml,
  writeDesktopFile,
} from "./appimage.ts";
import {
  boxIds,
  buildImage,
  engineBinary,
  engineMode,
  initEngine,
  nameOf,
  rememberEngine,
} from "./engine.ts";
import { containerfile } from "../assets/skill-sync.ts";
import { configure, runningOrca, userDataDir } from "./orca.ts";
import { die, plain, say, warn } from "./output.ts";

/** The commands this project installs, and the function behind each. */
export const TOOLS = [
  "orca-box",
  "orca-box-archive",
  "orca-box-login",
  "orca-box-configure-orca",
  "orca-box-install-orca",
  "orca-box-update",
  "orca-box-setup",
] as const;
export type Tool = (typeof TOOLS)[number];

export interface Paths {
  /** Where the tool's own files live. */
  data: string;
  /** Where the commands are linked. */
  bin: string;
  /** The installed program. */
  program: string;
  /** Where the agent image's Containerfile goes. */
  containerfile: string;
}

export function paths(): Paths {
  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  const data = join(dataHome, "orca-box");
  const prefix = process.env.PREFIX ?? join(homedir(), ".local");
  return {
    data,
    bin: join(prefix, "bin"),
    program: join(data, "orca-box"),
    containerfile: join(data, "Containerfile"),
  };
}

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

/** Install the Orca app from a release, or from an AppImage the user has. */
export async function installOrcaApp(from: string): Promise<void> {
  const { asset, yml } = assetNames();
  const { dir, dest } = appPaths();
  const api = process.env.ORCA_BOX_GITHUB_API ?? "https://api.github.com";

  mkdirSync(dir, { recursive: true });
  const work = join(dataWork(), "appimage");
  mkdirSync(work, { recursive: true });
  const newApp = join(work, "new.AppImage");

  let version = "";

  if (from) {
    if (!existsSync(from)) die(`no such file: ${from}`);
    copyFileSync(from, newApp);
    say(`Installing ${from}`);
  } else {
    say("Looking up the latest Orca release");
    let release: unknown;
    try {
      release = JSON.parse(
        await fetchText(`${api}/repos/stablyai/orca/releases/latest`),
      );
    } catch {
      die(
        "couldn't reach GitHub's API. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE",
      );
    }
    const info = await releaseInfo(release as Parameters<typeof releaseInfo>[0]);
    version = info.version;
    if (!info.url) {
      die(
        `release ${version || "latest"} has no ${asset}. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE`,
      );
    }

    // Already have exactly this build? (Orca's updater may have got there first.)
    if (info.sha256 && existsSync(dest) && sha256File(dest) === info.sha256) {
      say(`Orca ${version} is already installed at ${dest}`);
    } else {
      say(`Downloading Orca ${version} (${asset})`);
      try {
        await fetchToFile(info.url, newApp);
      } catch (err) {
        die(`couldn't download Orca: ${(err as Error).message}`);
      }

      if (info.sha256) {
        if (sha256File(newApp) !== info.sha256) {
          die("SHA-256 of the download doesn't match GitHub's digest; not installing");
        }
        say("Verified SHA-256 against GitHub's digest");
      } else if (info.ymlUrl) {
        let ymlText = "";
        try {
          ymlText = await fetchText(info.ymlUrl);
        } catch {
          ymlText = "";
        }
        if (ymlText) {
          const want = sha512FromYml(ymlText, asset);
          if (!want) {
            die(`no sha512 for this file in ${yml}; not installing`);
          }
          if (sha512FileBase64(newApp) !== want) {
            die(`the download doesn't match the SHA-512 in ${yml}; not installing`);
          }
          say(`Verified SHA-512 against ${yml}`);
        } else if (process.env.ORCA_BOX_ALLOW_UNVERIFIED === "1") {
          warn(
            `no checksum published for ${asset}; installing unverified (ORCA_BOX_ALLOW_UNVERIFIED=1)`,
          );
        } else {
          die(
            `no checksum published for ${asset}, so it can't be verified. Set ORCA_BOX_ALLOW_UNVERIFIED=1 to install anyway.`,
          );
        }
      } else if (process.env.ORCA_BOX_ALLOW_UNVERIFIED === "1") {
        warn(
          `no checksum published for ${asset}; installing unverified (ORCA_BOX_ALLOW_UNVERIFIED=1)`,
        );
      } else {
        die(
          `no checksum published for ${asset}, so it can't be verified. Set ORCA_BOX_ALLOW_UNVERIFIED=1 to install anyway.`,
        );
      }
    }
  }

  if (existsSync(newApp)) {
    // Is it even an AppImage?
    const head = readFileSync(newApp).subarray(0, 4);
    if (head[0] !== 0x7f || head[1] !== 0x45 || head[2] !== 0x4c || head[3] !== 0x46) {
      die("that file isn't an AppImage (not an ELF executable)");
    }
    chmodSync(newApp, 0o755);
    // Same-folder rename: atomic, and a running Orca keeps its old copy open.
    const tmp = join(dir, `.orca.AppImage.${process.pid}`);
    copyFileSync(newApp, tmp);
    chmodSync(tmp, 0o755);
    Bun.spawnSync(["mv", "-f", tmp, dest]);
    say(`Installed ${dest}`);
  }

  // --- menu entry, from the .desktop file and icons inside the AppImage ---
  say("Adding Orca to the application menu");
  const extract = join(work, "extract");
  mkdirSync(extract, { recursive: true });
  for (const pattern of ["*.desktop", "usr/share/icons/*", ".DirIcon"]) {
    Bun.spawnSync([dest, "--appimage-extract", pattern], {
      cwd: extract,
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  const root = join(extract, "squashfs-root");

  if (!installIcons(root) && !installFallbackIcon(root)) {
    warn("couldn't extract Orca's icon; the menu entry will use a generic one");
  }

  const { desktopFile } = appPaths();
  if (existsSync(desktopFile) && !readFileSync(desktopFile, "utf8").includes("X-Orca-Box=true")) {
    copyFileSync(desktopFile, `${desktopFile}.bak`);
    warn(`replaced an existing ${desktopFile} (saved as ${desktopFile}.bak)`);
  }

  let embedded = "";
  try {
    for (const entry of readdirSync(root)) {
      if (entry.endsWith(".desktop")) {
        embedded = join(root, entry);
        break;
      }
    }
  } catch {
    embedded = "";
  }
  writeDesktopFile(embedded, dest, "orca-ide", version);

  Bun.spawnSync(["rm", "-rf", work]);
}

/** A scratch folder for the installer's temporary files. */
function dataWork(): string {
  const dir = join(paths().data, "work");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Point Orca's agents at orca-box. */
async function configureOrca(yolo: boolean): Promise<boolean> {
  const { bin, program } = paths();
  const saved = join(CONFIG_FILE_DIR, "orca-previous-commands.json");

  // Orca adds ~/.local/bin to its own PATH, so the bare name works for
  // terminal tabs and background jobs alike, and is the same on every
  // machine. A literal "~" would not work: Orca runs background jobs
  // without a shell. With a custom PREFIX, Orca can't find the bare name,
  // so use the full path.
  let prefix = "orca-box";
  const localBin = join(homedir(), ".local", "bin");
  if (bin !== localBin) {
    prefix = join(bin, "orca-box");
  }

  try {
    await configure({
      action: "set",
      yolo,
      boxPath: program,
      savedPath: saved,
      prefix,
    });
    return true;
  } catch {
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
      Bun.spawnSync([engineBinary(), "rm", "-f", id], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }
    say(`Removing image ${setting("ORCA_BOX_IMAGE")}`);
    Bun.spawnSync([engineBinary(), "rmi", "-f", setting("ORCA_BOX_IMAGE")], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if (options.purge) {
      say(`Deleting saved logins (volume ${setting("ORCA_BOX_HOME_VOLUME")})`);
      Bun.spawnSync([engineBinary(), "volume", "rm", "-f", setting("ORCA_BOX_HOME_VOLUME")], {
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
  for (const tool of [...TOOLS, "orca-box-lib.sh"]) {
    try {
      unlinkSync(join(bin, tool));
    } catch {
      // Not there.
    }
  }
  Bun.spawnSync(["rm", "-rf", data, CONFIG_FILE_DIR]);
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
  for (const tool of ["git", "python3"]) {
    if (Bun.spawnSync(["which", tool], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
      die(`${tool} not found`);
    }
  }
  if (
    options.installApp &&
    Bun.spawnSync(["which", "curl"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0 &&
    !options.appFrom
  ) {
    die("curl not found");
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
      const version = Bun.spawnSync(["podman", "version", "--format", "{{.Client.Version}}"], {
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
      break;
    }
    case "docker":
      say("Using Docker");
      plain("    Note: access to the Docker daemon is root-equivalent on this machine;");
      plain("    the boxes themselves still run as your user with no capabilities.");
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
    symlinkSync(program, link);
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

  const pathEntries = (process.env.PATH ?? "").split(":");
  if (!pathEntries.includes(bin)) {
    warn(`${bin} is not on your PATH; Orca uses the full paths, so that's fine.`);
  }

  // --- 4. Orca settings ----------------------------------------------------
  let orcaDone = false;
  let runningFrom = "";
  if (options.changeOrca) {
    let running = runningOrca();
    if (running.pid === 0 && options.launch && existsSync(appPaths().dest)) {
      say("Starting Orca to apply its settings");
      Bun.spawnSync(["setsid", "-f", appPaths().dest], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
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

/** Remove every box. */
function archiveAll(): void {
  for (const id of boxIds()) {
    Bun.spawnSync([engineBinary(), "rm", "-f", id], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
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
      "couldn't find the program to install; run the installer from a checkout",
    );
  }
  if (source === dest) return;
  const tmp = `${dest}.${process.pid}.tmp`;
  copyFileSync(source, tmp);
  chmodSync(tmp, 0o755);
  Bun.spawnSync(["mv", "-f", tmp, dest]);
}

/** The file this program is running from, if any. */
export function currentProgram(): string {
  // A compiled program: execPath is the executable itself.
  const exec = process.execPath;
  if (exec && !exec.includes("bunfs") && existsSync(exec)) return exec;
  // Running from source: argv[1] is the script.
  const fromArgv = process.argv[1];
  if (fromArgv && existsSync(fromArgv) && !fromArgv.includes("bunfs")) {
    return fromArgv;
  }
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
  plain(`      ${join(bin, "orca-box-archive")}`);
  plain("    (boxes also delete themselves after 2 minutes with nothing running).");
  plain();
  plain(" Update later with: orca-box-update  (add --agents --orca to refresh the");
  plain(" agent image and Orca too; --enable-auto to check daily)");
}

function appStep(options: SetupOptions, dest: string, runningFrom: string): string {
  if (!options.installApp) return "Orca app: unchanged (--no-orca-app).";
  let text = `Orca app: ${dest}, in your application menu as "Orca".`;
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
