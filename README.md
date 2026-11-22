# orca-box

Run [Claude Code](https://claude.com/claude-code), [Codex](https://openai.com/codex)
and [pi](https://github.com/earendil-works/pi-coding-agent) from
[Orca](https://orca.dev) inside a separate container per workspace, so agents
run without permission prompts and without reaching the rest of your machine.

## Install

```sh
curl -fsSL https://github.com/ggpwnkthx/orca-box/releases/latest/download/install.sh | bash
```

That installs everything **into your own account**: the program in
`~/.local/share/orca-box`, the commands in `~/.local/bin`, the settings in
`~/.config/orca-box`, the Orca app in `~/AppImages`. Nothing is written
outside your home directory and nothing needs `sudo`.

If [Bun](https://bun.sh) isn't installed yet, the installer puts it in
`~/.bun` — also yours alone. If you'd rather install it yourself first:

```sh
curl -fsSL https://bun.sh/install | bash   # into ~/.bun
```

### Options

| Option | What it does |
| --- | --- |
| `--git=rw` | let agents stage and commit (default: read-only `.git`) |
| `--yolo` | set the agents to Yolo permissions (the container is the boundary) |
| `--gh-auth` | give agents your GitHub credentials, read-only |
| `--no-orca-app` | don't download or update the Orca app |

`orca-box-setup --help` has the full list.

## What gets installed

| Where | What |
| --- | --- |
| `~/.local/share/orca-box/` | the program and its data |
| `~/.local/bin/` | the `orca-box` commands (links into the above) |
| `~/.config/orca-box/` | the settings |
| `~/.local/share/applications/` | the Orca menu entry |
| `~/AppImages/` | the Orca app itself |
| `~/.config/systemd/user/` | the daily update timer, if you enable it |

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
- the GitHub CLI; with `ORCA_BOX_GH_AUTH=1` it also gets your `gh` credentials

It cannot see the rest of your home directory, `~/.ssh`, or other repos.

## What it needs

The host needs very little:

| What | Why | If it's missing |
| --- | --- | --- |
| `git` | finding the worktree | the installer says so |
| Podman **or** Docker | running the boxes | the installer says so |
| `flock` | one launch per workspace | boxes still work, but two can start at once |

Everything else is optional and checked where it's used: `curl`,
`systemctl` (for the daily update timer), `update-desktop-database` and
`desktop-file-validate` (for the menu entry), `newuidmap` and a
`/etc/subuid` range (for rootless Podman). None of them are needed to
*install* orca-box, and missing ones are reported, never fatal.

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

## The container engine

Podman if it works, otherwise Docker. Both are fine; the difference is in how
your user maps onto the container's (`userns=keep-id` for Podman, your own
UID/GID for Docker, container root for rootless Docker).

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

## Repository layout

```
install.sh              the bootstrapper: puts Bun in ~/.bun if needed,
                         installs the program, runs the installer
build.sh                builds the self-contained executable into dist/
src/
  main.ts               the command line: dispatch by the name invoked
  lib/
    box.ts              the box: mounts, locking, creation, exec
    config.ts           ~/.config/orca-box/config
    engine.ts           Podman or Docker
    orca.ts             talks to Orca over its private local socket
    appimage.ts         the Orca app and its menu entry
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

The build produces a **single self-contained executable**: the Containerfile
and the skill-sync script are embedded at compile time, so installing it is
one file in your own space, with nothing else to install alongside it.

## Development

```sh
bun install
bun test           # 21 tests; they need no Podman, Docker or Orca
bun x tsc --noEmit # typecheck
./build.sh         # build for this machine
./build.sh --all   # build for every released platform
```

The tests use a mock container engine and a mock Orca daemon, so they need
neither Podman nor Docker nor Orca installed.

## License

MIT. See [LICENSE](LICENSE).
