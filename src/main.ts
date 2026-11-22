/**
 * orca-box — the command line.
 *
 * One program, several names: orca-box, orca-box-archive, orca-box-login
 * and so on are links to this one, and each acts on the name it is called
 * by. The name is taken from the process's command line, which is how the
 * kernel saw it, so it survives being run through a symlink.
 */

import { join } from "node:path";
import { CONFIG_FILE_DIR, loadConfig, setting } from "./lib/config.ts";
import { invokeName } from "./lib/invoke.ts";
import { initEngine } from "./lib/engine.ts";
import { archive, login, runAgent } from "./lib/box.ts";
import { configure } from "./lib/orca.ts";
import { installOrcaApp, removeApp } from "./lib/app.ts";
import { isInstalled, paths } from "./lib/paths.ts";
import { resolveCommand } from "./lib/command.ts";
import {
  orcaCommandPrefix,
  setup,
  uninstall,
  type SetupOptions,
} from "./lib/setup.ts";
import { setAutoUpdate, update, type UpdateOptions } from "./lib/update.ts";
import { VERSION } from "./lib/version.ts";
import { die, plain, say, setQuiet } from "./lib/output.ts";

/** The name this program was invoked as. */
function invokedName(): string {
  return invokeName();
}

/** The arguments, without the program's own name. */
function toolArgs(): string[] {
  return process.argv.slice(2);
}

const USAGE: Record<string, string> = {
  "orca-box": `orca-box — run a coding agent inside a container dedicated to the current
Orca worktree, using Podman or Docker (whichever orca-box-setup found). The
container is created on first launch, reused by every later agent in the
same worktree, and deletes itself after ORCA_BOX_IDLE_SECONDS (default 120)
with nothing running in it.

Set as the Command of Orca's Claude Code, Codex and pi agents (see
orca-box-configure-orca), or use as a custom agent: orca-box claude ...
Works both in Orca's terminal tabs and for the background jobs Orca runs
through the same command (model lists, chat, commit messages).

What the container can see:
  - this worktree, read-write, at the same path as on the host
  - the repo's shared .git directory, READ-ONLY by default. With
    ORCA_BOX_GIT=rw (env, or ~/.config/orca-box/config) agents can stage and
    commit; anything git could be made to execute on the host stays read-only.
  - a named volume used as $HOME (agent logins), shared by all boxes
  - your host skills, read-only, added to the box's own: everything in
    ~/.agents/skills, ~/.claude/skills, ~/.codex/skills, ~/.pi/agent/skills
    (live: a skill you install later shows up in the running box;
    ORCA_BOX_SKILLS=0 to turn off)
  - the GitHub CLI (gh). With ORCA_BOX_GH_AUTH=1 it also gets your gh
    credentials, read-only: agents can then use your gh login. Whoever runs
    in the box can read that token, so only turn this on when you want that.
It cannot see the rest of your home directory, ~/.ssh, or other repos.
Run outside a repo (from ~, a ~/.dotdir or outside ~), it gets a throwaway
box with no host files at all; from another folder under ~, just that folder.
`,
  "orca-box-archive": `orca-box-archive — remove agent boxes right away instead of waiting for
them to go idle.

  orca-box-archive          remove the box for the current worktree, plus
                            any box whose worktree folder no longer exists
  orca-box-archive --all    remove every orca-box container

Optional as Orca's Archive Script; boxes also remove themselves when idle.
Only touches containers made from the orca-agents image or carrying the
orca.worktree label, never your other containers.
`,
  "orca-box-login": `orca-box-login — sign in to Claude Code, Codex and pi once, for every box.

  orca-box-login            open a shell; run \`claude\` (/login),
                            \`codex login\`, \`pi\` (/login), then \`exit\`
  orca-box-login claude     start one agent directly to sign in

Logins are saved in the shared home volume that every orca-box container
mounts. This one-off container uses the host network so browser logins that
call back to localhost (e.g. Codex on port 1455) work; your workspace boxes
keep their own isolated network.
`,
  "orca-box-configure-orca": `orca-box-configure-orca — point Orca's built-in Claude Code, Codex and pi
agents at orca-box, so launching them from Orca runs them in a box.

  orca-box-configure-orca           set the command for claude, codex, pi
  orca-box-configure-orca --yolo    also set those agents' permissions to
                                    "Yolo" (safe here: the box is the limit)
  orca-box-configure-orca --unset   put back the commands these agents had
                                    before (only where they still point at
                                    orca-box)

This is the same setting as Settings → Agents → <agent> → Command. It talks
to the running Orca app over its private local socket, the way Orca's own
\`orca\` CLI does, so Orca applies and saves the change itself. Orca must be
running; nothing is written to Orca's files directly.
`,
  "orca-box-install-orca": `orca-box-install-orca — install or update the Orca app and add it
to your application menu.

  orca-box-install-orca              download the latest release from
                                     github.com/stablyai/orca, verify it,
                                     install it and add the menu entry
  orca-box-install-orca --from FILE  install an app file you downloaded
                                     yourself (e.g. from orca.dev)
  orca-box-install-orca --remove     remove the installed app and menu entry
                                     (keeps Orca's settings)

On Linux the app is an AppImage: it goes to ~/AppImages/orca.AppImage
(Gear Lever's default folder; change with ORCA_APPIMAGE_DIR). The file stays
writable by you so Orca's built-in updater can keep updating it in place.

On macOS the app is a bundle: the disk image from the release is mounted and
Orca.app is copied to ~/Applications (change with ORCA_APP_DIR). The bundle
is the application-menu entry, so there is no separate menu file.

On Windows the app is an installer: orca-windows-setup.exe is downloaded,
checked and then run, and you finish the wizard it opens.

The download is checked against the SHA-256 digest GitHub publishes for the
file, or else the SHA-512 in the release's checksum file (what Orca's own
updater uses). With neither available it refuses, unless
ORCA_BOX_ALLOW_UNVERIFIED=1.
`,
  "orca-box-update": `orca-box-update — update orca-box to the latest release from its GitHub
Releases page (the source URL in the program's header; ORCA_BOX_SOURCE_URL
to use another copy).

  orca-box-update             update orca-box, keeping your settings
  orca-box-update --check     only say whether an update is available
  orca-box-update --agents    also rebuild the agent image with the latest
                              Claude Code, Codex and pi
  orca-box-update --orca      also update the Orca app
  orca-box-update --restart   afterwards, remove running boxes so they use the
                              update right away (stops agents running in them);
                              otherwise they switch once they go idle
  orca-box-update --enable-auto   check for and install orca-box updates daily
  orca-box-update --disable-auto  (a systemd user timer on Linux, a launchd
                                  agent on macOS; script updates only, never
                                  restarts boxes or rebuilds the image)
  --quiet                     print only when something changed

The download must be a valid orca-box program before it's used; the new
version's own installer then installs it.
`,
  "orca-box-setup": `orca-box-setup — set up Orca with orca-box: the Orca app itself, plus one
container per Orca workspace for Claude Code, Codex and pi. Uses Podman if it
works, otherwise Docker.

  orca-box-setup                    install/update Orca, install orca-box, build the
                             agent image, point Orca's agents at orca-box
  orca-box-setup --update           same, and rebuild the image with the latest
                             agent versions
  orca-box-setup --uninstall        remove orca-box (scripts, image, containers) and
                             reset Orca's agent commands. Keeps the Orca app
                             and your logins; --purge removes both too

Options:
  --yolo              also set Claude/Codex/pi permissions in Orca to Yolo
                      (no prompts; the box is the boundary)

  --git=rw            let agents stage and commit (default --git=ro:
                      read-only .git; you commit from Orca). Saved in
                      ~/.config/orca-box/config
  --gh-auth           give agents in the boxes your GitHub credentials, so
                      their gh commands are logged in as you. Read-only, and
                      anyone in a box can read the token. Saved in
                      ~/.config/orca-box/config
  --no-orca-app       don't download/update the Orca app or its menu entry
  --orca-from FILE    install Orca from an app file you downloaded yourself
  --no-launch         don't start Orca to apply its settings
  --no-orca           don't change Orca's settings
  --no-build          don't build the agent image

Orca goes to ~/AppImages/orca.AppImage (ORCA_APPIMAGE_DIR to change) with an
application-menu entry, or to ~/Applications/Orca.app (ORCA_APP_DIR) on
macOS. Orca must be running to change its settings; if it isn't, the
installer starts it (unless --no-launch).

Environment: PREFIX (default ~/.local, %LOCALAPPDATA%\orca-box on Windows)
             — the commands go to $PREFIX/bin.
             ORCA_BOX_ENGINE=podman|docker to override auto-detection.
`,
};

/** Print a tool's usage and exit. */
function usage(tool: string): never {
  plain(USAGE[tool] ?? "");
  process.exit(0);
}

/**
 * Set up a copy of the program that has not been installed yet.
 *
 * The program installs itself, builds the agent image and points Orca's
 * agents at it; after that, the command that was asked for runs.
 */
async function setUpACopy(): Promise<void> {
  say("This copy of orca-box hasn't been set up yet, so it sets itself up first.");
  await setup(parseSetupOptions([]));
}

/** The installer's own options. */
function parseSetupOptions(args: string[]): SetupOptions {
  const options: SetupOptions = {
    mode: "install",
    purge: false,
    yolo: false,
    gitMode: "",
    ghAuth: false,
    installApp: true,
    appFrom: "",
    launch: true,
    changeOrca: true,
    build: true,
    keepBoxes: false,
    brief: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    switch (arg) {
      case "--update":
        options.mode = "update";
        break;
      case "--uninstall":
        options.mode = "uninstall";
        break;
      case "--purge":
        options.purge = true;
        break;
      case "--yolo":
        options.yolo = true;
        break;
      case "--git=ro":
      case "--git=rw":
        options.gitMode = arg.slice("--git=".length);
        break;
      case "--gh-auth":
        options.ghAuth = true;
        break;
      case "--no-orca-app":
        options.installApp = false;
        break;
      case "--orca-from": {
        const value = args[++i];
        if (!value) die("--orca-from needs a file");
        options.appFrom = value;
        break;
      }
      case "--no-launch":
        options.launch = false;
        break;
      case "--no-orca":
        options.changeOrca = false;
        break;
      case "--no-build":
        options.build = false;
        break;
      case "--keep-boxes":
        options.keepBoxes = true;
        break;
      case "--brief":
        options.brief = true;
        break;
      case "-h":
      case "--help":
        usage("orca-box-setup");
      default:
        process.stderr.write(`unknown option: ${arg} (see --help)\n`);
        process.exit(2);
    }
  }
  return options;
}

/** The updater's own options. */
function parseUpdateOptions(args: string[]): UpdateOptions {
  const options: UpdateOptions = {
    check: false,
    agents: false,
    orca: false,
    restart: false,
    quiet: false,
    auto: "",
  };
  for (const arg of args) {
    switch (arg) {
      case "--check":
        options.check = true;
        break;
      case "--agents":
        options.agents = true;
        break;
      case "--orca":
        options.orca = true;
        break;
      case "--restart":
        options.restart = true;
        break;
      case "--quiet":
        options.quiet = true;
        setQuiet(true);
        break;
      case "--enable-auto":
        options.auto = "on";
        break;
      case "--disable-auto":
        options.auto = "off";
        break;
      case "-h":
      case "--help":
        usage("orca-box-update");
      default:
        process.stderr.write(`unknown option: ${arg} (see --help)\n`);
        process.exit(2);
    }
  }
  return options;
}

/** Run the tool the program was invoked as. */
async function main(): Promise<void> {
  loadConfig();

  let name = invokedName();
  let args = toolArgs();

  // --version works whatever the program is called.
  if (args[0] === "--version" || args[0] === "-V") {
    plain(VERSION);
    process.exit(0);
  }

  // Which command is this?
  const command = resolveCommand(name, args);
  name = command.name;
  args = command.args;

  // A copy of the program that has not been set up yet: it installs
  // itself and sets everything up first, and then does what was asked.
  if (!isInstalled() && name !== "orca-box-setup") {
    await setUpACopy();
  }

  switch (name) {
    case "orca-box": {
      if (args[0] === "-h" || args[0] === "--help") usage("orca-box");
      await runAgent(args);
      break;
    }
    case "orca-box-archive": {
      if (args[0] === "-h" || args[0] === "--help") usage("orca-box-archive");
      initEngine();
      archive(args.includes("--all"));
      break;
    }
    case "orca-box-login": {
      if (args[0] === "-h" || args[0] === "--help") usage("orca-box-login");
      initEngine();
      await login(args);
      break;
    }
    case "orca-box-configure-orca": {
      let action: "set" | "unset" = "set";
      let yolo = false;
      for (const arg of args) {
        if (arg === "--unset") action = "unset";
        else if (arg === "--yolo") yolo = true;
        else if (arg === "-h" || arg === "--help") usage("orca-box-configure-orca");
        else {
          process.stderr.write(`unknown option: ${arg} (see --help)\n`);
          process.exit(2);
        }
      }
      try {
        const ok = await configure({
          action,
          yolo,
          boxPath: paths().program,
          savedPath: join(CONFIG_FILE_DIR, "orca-previous-commands.json"),
          prefix: orcaCommandPrefix(),
        });
        process.exit(ok ? 0 : 1);
      } catch (err) {
        die(`orca-box-configure-orca: ${(err as Error).message}`, 3);
      }
      break;
    }
    case "orca-box-install-orca": {
      let from = "";
      let remove = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i] ?? "";
        if (arg === "--from") {
          const value = args[++i];
          if (!value) die("--from needs a file");
          from = value;
        } else if (arg === "--remove") {
          remove = true;
        } else if (arg === "-h" || arg === "--help") {
          usage("orca-box-install-orca");
        } else {
          die(`unknown option: ${arg} (see --help)`);
        }
      }
      if (remove) removeApp();
      else await installOrcaApp(from);
      break;
    }
    case "orca-box-update": {
      const options = parseUpdateOptions(args);
      await update(options);
      break;
    }
    case "orca-box-setup": {
      const options = parseSetupOptions(args);
      if (options.mode === "uninstall") {
        await uninstall(options);
        break;
      }
      await setup(options);
      break;
    }
    default:
      usage("orca-box-setup");
  }
}

await main();
