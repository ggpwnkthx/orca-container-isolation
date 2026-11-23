# orca-box

Run [Claude Code](https://claude.com/claude-code), [Codex](https://openai.com/codex)
and [pi](https://github.com/earendil-works/pi-coding-agent) from
[Orca](https://orca.dev) inside a separate container per workspace, so agents
run without permission prompts and without reaching the rest of your machine.

## Install

Download the program for your machine from the
[releases page](https://github.com/ggpwnkthx/orca-container-isolation/releases/latest) and
run it. There is one file, and it needs nothing else:

| Platform | File |
| --- | --- |
| Linux (x64, glibc) | `orca-box-linux-x64` |
| Linux (x64, musl — Alpine) | `orca-box-linux-x64-musl` |
| Linux (arm64, glibc) | `orca-box-linux-arm64` |
| Linux (arm64, musl) | `orca-box-linux-arm64-musl` |
| macOS (Apple silicon) | `orca-box-darwin-arm64` |
| macOS (Intel) | `orca-box-darwin-x64` |
| Windows | `orca-box-windows-x64.exe` |

```sh
chmod +x orca-box-linux-x64     # Linux and macOS
./orca-box-linux-x64
```

### One line

Or paste one line into a terminal: it downloads the right build, makes it
runnable and starts it, and the program sets itself up from there.

**Linux (x64, glibc)**

```sh
curl -fsSL https://github.com/ggpwnkthx/orca-container-isolation/releases/latest/download/orca-box-linux-x64 -o /tmp/orca-box && chmod +x /tmp/orca-box && /tmp/orca-box
```

**Linux (x64, musl — Alpine)**

```sh
curl -fsSL https://github.com/ggpwnkthx/orca-container-isolation/releases/latest/download/orca-box-linux-x64-musl -o /tmp/orca-box && chmod +x /tmp/orca-box && /tmp/orca-box
```

**Linux (arm64, glibc)**

```sh
curl -fsSL https://github.com/ggpwnkthx/orca-container-isolation/releases/latest/download/orca-box-linux-arm64 -o /tmp/orca-box && chmod +x /tmp/orca-box && /tmp/orca-box
```

**Linux (arm64, musl)**

```sh
curl -fsSL https://github.com/ggpwnkthx/orca-container-isolation/releases/latest/download/orca-box-linux-arm64-musl -o /tmp/orca-box && chmod +x /tmp/orca-box && /tmp/orca-box
```

**macOS (Apple silicon)**

```sh
curl -fsSL https://github.com/ggpwnkthx/orca-container-isolation/releases/latest/download/orca-box-darwin-arm64 -o /tmp/orca-box && chmod +x /tmp/orca-box && /tmp/orca-box
```

**macOS (Intel)**

```sh
curl -fsSL https://github.com/ggpwnkthx/orca-container-isolation/releases/latest/download/orca-box-darwin-x64 -o /tmp/orca-box && chmod +x /tmp/orca-box && /tmp/orca-box
```

**Windows** (PowerShell)

```powershell
Invoke-WebRequest https://github.com/ggpwnkthx/orca-container-isolation/releases/latest/download/orca-box-windows-x64.exe -OutFile "$env:TEMP\orca-box.exe"; & "$env:TEMP\orca-box.exe"
```

If `curl` is not there, `wget -O /tmp/orca-box <url>` does the same
download.

On Windows, run `orca-box-windows-x64.exe`; it asks nothing and needs no
administrator rights.

Running it like that sets everything up. It installs **into your own
account**: the program copies itself to `~/.local/share/orca-box`, the
commands go to `~/.local/bin`, the settings to `~/.config/orca-box`, and
the Orca app to `~/AppImages` (Linux) or `~/Applications` (macOS). Nothing
is written outside your home directory and nothing needs `sudo`.

It then builds the agent image, installs the Orca app and points Orca's
Claude Code, Codex and pi agents at orca-box, so that launching them from
Orca runs them in a box.

### The first run

The file you download is not the program you keep: it installs *itself*
and then it is the program you keep, with the commands beside it. So:

| You run | What happens |
| --- | --- |
| the downloaded file, with no arguments | it installs itself and sets everything up |
| the downloaded file, with an agent (`… claude`) | it sets itself up, then runs the agent |
| a command (`orca-box`, `orca-box-archive`, …) | that command, as usual |

Which command a name means is a question about the name; whether the
program is set up yet is a question about the program, and the program
answers it by looking at where it is installed.

To check the download, compare it with the checksum in the release:

```sh
sha256sum orca-box-linux-x64     # or: shasum -a 256 orca-box-linux-x64
```

On macOS, `~/.local/bin` isn't on your PATH by default, so add it once:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

On Windows the commands go to `%LOCALAPPDATA%\orca-box\bin`, and the
setup adds that folder to your PATH for you.

### Options

| Option | What it does |
| --- | --- |
| `--git=rw` | let agents stage and commit (default: read-only `.git`) |
| `--yolo` | set the agents to Yolo permissions (the container is the boundary) |
| `--gh-auth` | give agents your GitHub credentials, read-only (boxes that are already running need `orca-box-archive`) |
| `--no-orca-app` | don't download or update the Orca app |

`orca-box-setup --help` has the full list.

## What gets installed

| Where | What |
| --- | --- |
| `~/.local/share/orca-box/` | the program and its data |
| `~/.local/bin/` | the `orca-box` commands (links into the above) |
| `~/.config/orca-box/` | the settings |
| `~/AppImages/` | the Orca app itself (Linux) |
| `~/Applications/Orca.app` | the Orca app itself (macOS) |
| `~/.local/share/applications/` | the Orca menu entry (Linux) |
| `~/.config/systemd/user/` | the daily update timer, if you enable it (Linux) |
| `~/Library/LaunchAgents/` | the daily update agent, if you enable it (macOS) |
| `%LOCALAPPDATA%\orca-box\` | the program and its data (Windows) |
| `%LOCALAPPDATA%\orca-box\bin\` | the `orca-box` commands (Windows) |
| `%APPDATA%\orca-box\` | the settings (Windows) |

Each command acts on the name it is called by:

| Command | What it does |
| --- | --- |
| `orca-box AGENT [ARGS]` | run an agent in the current workspace's box |
| `orca-box-login` | sign in to the agents once, for every box |
| `orca-box-archive [--all]` | remove boxes now instead of waiting for idle |
| `orca-box-configure-orca` | point Orca's agents at `orca-box` (or `--unset`) |
| `orca-box-install-orca` | install/update the Orca app + menu entry |
| `orca-box-update` | update `orca-box` from the latest release |
| `orca-box-setup` | the installer itself |

## How it works

Each Orca workspace gets its own container, built from
[`container/Containerfile`](container/Containerfile). The container sees:

- the worktree, read-write, at the same path as on the host
- the repo's shared `.git` directory, **read-only by default**; with
  `ORCA_BOX_GIT=rw` agents may stage and commit, while everything git could
  later be made to *execute* on the host stays read-only
- a named volume used as `$HOME`, shared by all boxes (so logins are shared)
- your host's skills, read-only, added to the box's own
- the GitHub CLI; with `ORCA_BOX_GH_AUTH=1` it also gets your `gh`
  credentials: your gh settings folder is mounted read-only, and your
  token is passed in the environment. The token is looked for where gh
  looks for it: in the environment, in your gh settings file, and in the
  system credential store (the login keychain on macOS, the credential
  manager on Windows), where gh keeps it on the platforms that have one
  and falls back to a plain-text file only where there is none. The
  host's `gh` is asked for the credential store, and it is looked for
  beyond the PATH as well, because the program is usually started by
  Orca, whose own PATH is a short one. The token is passed to the
  engine by name, so it is not in the command line, where every process
  on the machine could read it; a GitHub Enterprise host also gets it as
  `GITHUB_ENTERPRISE_TOKEN`, which is the name gh looks for there. Both
  are decided when the box is made: a box that is already running keeps
  the mounts it was made with, so run `orca-box-archive` after turning
  the setting on or off. Signing in inside a box works too
  (`orca-box-login`, then `gh auth login`): the boxes share one home, so
  that login is shared by all of them. On Docker Desktop, use VirtioFS
  file sharing: with the older gRPC-FUSE sharing the credential file
  belongs to root in the container, and the agent cannot read it.

It cannot see the rest of your home directory, `~/.ssh`, or other repos.

## What it needs

The host needs very little:

| What | Why | If it's missing |
| --- | --- | --- |
| `git` | finding the worktree | the installer says so |
| Docker, or Podman on Linux and macOS | running the boxes | the installer says so |
| `flock` (Linux) or `lockf` (macOS) | one launch per workspace | boxes still work, but two can start at once |

Nothing else is needed: the program brings its own runtime, and it does
its own downloading. Everything else is optional and checked where it is
used: `systemctl` (for the daily update timer on Linux),
`update-desktop-database` and `desktop-file-validate` (for the menu entry),
`newuidmap` and a `/etc/subuid` range (for rootless Podman). Missing ones
are reported, never fatal.

Two things differ by distribution, and both are handled:

- **glibc or musl.** The installer picks the matching build, so Alpine
  works as well as Debian, Ubuntu, Fedora, Arch and openSUSE.
- **SELinux or AppArmor.** On SELinux systems (Fedora, Bazzite) the
  bind mounts get the `z` option so the container can read them; on
  AppArmor systems (Debian, Ubuntu) it isn't needed and isn't added.

Rootless Podman also needs a range of subordinate ids for your user. If
`/etc/subuid` doesn't have one, the installer says so and tells you how to
add it:

```sh
sudo usermod --add-subuids $(id -u)-65536 --add-subgids $(id -g)-65536 $(id -un)
```

### On macOS

macOS has no AppImage, no systemd and no `/proc`, so a few things work
differently:

- **The Orca app** is a bundle. The disk image from the Orca release is
  mounted with `hdiutil` and `Orca.app` is copied to `~/Applications`
  (`ORCA_APP_DIR` to change that). The bundle *is* the application-menu
  entry, so there is no `.desktop` file to write.
- **The daily update** is a launchd agent in
  `~/Library/LaunchAgents/dev.orca-box.update.plist`, instead of a systemd
  timer.
- **The lock** uses `lockf` instead of `flock`; if neither is there,
  orca-box falls back to a lock file of its own.
- **The command names** are read from `ps` instead of `/proc/self/cmdline`,
  so the links in `~/.local/bin` still work.

Docker Desktop is the usual engine on macOS. Two things to know:

- The worktree has to be in a folder Docker Desktop shares with its virtual
  machine: your home folder, `/Volumes`, `/private` or `/tmp`. orca-box says
  so when it isn't.
- Use Docker Desktop's **VirtioFS** file sharing (the default since 4.34).
  With the older gRPC-FUSE sharing, the files in the box belong to root
  rather than to you, and the agents can't write to the worktree.

Podman works on macOS too, through `podman machine`; Docker Desktop is
usually the smoother choice. The machine shares your home folder by default,
so keep the worktree there, the same rule as for Docker Desktop.

### On Windows

Windows is the odd one out: the containers are still Linux containers
(Docker Desktop runs them in WSL2), but the host is not. A few things
follow from that.

- **Paths.** A Linux container cannot have a folder called `C:\Users\me`
  in it, so the drive becomes a folder: `C:\Users\me\project` is mounted
  at `/c/Users/me/project` in the box. The shape of the path is kept, so
  it still reads like the path on the host.
- **The engine.** Docker Desktop is the only supported engine on Windows.
  Podman's machine mounts the drives differently (`/mnt/c`, not `/c`) and
  has no host user to map onto a Linux uid, so the installer refuses
  Podman and points at Docker Desktop.
- **The commands.** Windows cannot run a program through a link without
  extra privileges, so the commands are small `.cmd` files in
  `%LOCALAPPDATA%\orca-box\bin` that call the program. They are meant
  to be typed in a shell. Orca, which starts programs directly and
  without a shell, is given the program itself with the name of the
  command as its first argument:
  `"C:\Users\me\AppData\Local\orca-box\orca-box.exe" claude`.
- **The Orca app** is an installer (`orca-windows-setup.exe`), which is
  downloaded, checked and then run: the user finishes the wizard. The
  program it installs is found in `%LOCALAPPDATA%\Programs`.
- **The daily update** is a task in the Task Scheduler, not a systemd
  timer or a launchd agent.
- **Git in the box.** The files Docker Desktop shares with the virtual
  machine belong to root in the container, so git is told to trust the
  directory (`safe.directory`); without that it refuses to work in the
  repository.

Docker Desktop shares the drives you tell it to (C: by default), so put
your worktrees there.

## The container engine

Podman if it works, otherwise Docker. Both are fine; the difference is in how
your user maps onto the container's (`userns=keep-id` for Podman, your own
UID/GID for Docker, container root for rootless Docker).

On Windows, Docker is the only engine. The boxes mount the worktree at
Docker Desktop's path (`C:\Users\me\project` becomes `/c/Users/me/project`)
and map the host user onto a Linux uid, and Podman's machine has neither, so
the installer refuses Podman and points at Docker Desktop.

## Configuration

`~/.config/orca-box/config`, `KEY=VALUE` lines. Environment variables win
over the file; the file wins over the defaults.

| Key | Default | Meaning |
| --- | --- | --- |
| `ORCA_BOX_GIT` | `ro` | `ro` or `rw`: whether agents may commit |
| `ORCA_BOX_IDLE_SECONDS` | `120` | how long a box lives with nothing running |
| `ORCA_BOX_MEMORY` | `8g` | memory limit per box (empty: no limit) |
| `ORCA_BOX_IMAGE` | `localhost/orca-agents:latest` | the agent image |
| `ORCA_BOX_SKILLS` | `1` | `0` turns off the host-skill mounts |
| `ORCA_BOX_GH_AUTH` | `0` | `1` gives agents your `gh` credentials |
| `ORCA_BOX_NO_NEW_PRIVILEGES` | `1` | `0` drops `--security-opt no-new-privileges` (for engines that don't know it) |

## Repository layout

```
build.sh                builds the self-contained executable into dist/
src/
  main.ts               the command line: dispatch by the name invoked
  lib/
    box.ts              the box: mounts, locking, creation, exec
    config.ts           ~/.config/orca-box/config
    engine.ts           Podman or Docker
    gh.ts               the GitHub CLI's credentials on this host
    orca.ts             talks to Orca over its private local socket
    app.ts              the Orca app, on any platform
    appimage.ts         the Orca app on Linux: the AppImage and its menu entry
    macapp.ts           the Orca app on macOS: the disk image and the bundle
    windowsapp.ts       the Orca app on Windows: the installer
    hostpath.ts         where a host folder is seen inside the box
    paths.ts            where orca-box puts its files
    platform.ts         which platform are we on
    release.ts          looking up the Orca release
    setup.ts            the installer
    update.ts           self-update
    invoke.ts           which command was invoked
    output.ts           say / warn / die
    which.ts            finding programs on PATH
  assets/
    skill-sync.ts       embeds the Containerfile and the skill-sync script
container/              the Containerfile and the skill-sync script
tests/                  the test suite
```

### Editing

The program is **TypeScript, running on Bun**. Edit `src/`, then:

```sh
bun install        # once
bun test           # the test suite
bun x tsc --noEmit # typecheck
./build.sh         # build the executable into dist/
```

On Windows, build it with Bun directly:

```powershell
bun build --compile --target bun-windows-x64 --outfile dist\orca-box-windows-x64.exe src\main.ts
```

The build produces a **single self-contained executable**: the Containerfile
and the skill-sync script are embedded at compile time, so installing it is
one file in your own space, with nothing else to install alongside it.

`./build.sh --all` builds every released platform, from either Linux or
macOS: Linux (glibc and musl, x64 and arm64) and macOS (x64 and arm64).

## Development

```sh
bun install
bun test           # the test suite; it needs no Podman, Docker or Orca
bun x tsc --noEmit # typecheck
./build.sh         # build for this machine
./build.sh --all   # build for every released platform
```

The tests use a mock container engine and a mock Orca daemon, so they need
neither Podman nor Docker nor Orca installed.

## License

MIT. See [LICENSE](LICENSE).
