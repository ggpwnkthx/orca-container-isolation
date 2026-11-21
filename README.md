# orca-box

Run [Claude Code](https://claude.com/claude-code), [Codex](https://openai.com/codex)
and [pi](https://github.com/earendil-works/pi-coding-agent) from
[Orca](https://orca.dev) inside a separate container per workspace, so agents
run without permission prompts and without reaching the rest of your machine.

This repository holds the source. The single file at the root — [`orca.sh`](orca.sh) —
is what people download and run; it is **generated** from `src/` by
[`build.sh`](build.sh), so the two can never drift apart.

## Install

```sh
# Download, review, then run.
curl -fsSLO https://raw.githubusercontent.com/ggpwnkthx/orca-box/main/orca.sh
less orca.sh
bash orca.sh --git=rw --yolo
```

Or in one line:

```sh
curl -fsSL https://raw.githubusercontent.com/ggpwnkthx/orca-box/main/orca.sh | bash
```

Run it as your normal user, not with `sudo`. Orca has to be running for its
agent settings to change; the installer starts it for you if it isn't.

Options (all optional; `bash orca.sh --help` for the full list):

| Option | What it does |
| --- | --- |
| `--git=rw` | let agents stage and commit (default: read-only `.git`) |
| `--yolo` | set the agents to Yolo permissions (the container is the boundary) |
| `--gh-auth` | give agents your GitHub credentials, read-only |
| `--no-orca-app` | don't download or update the Orca app |

## What gets installed

The installer copies `orca.sh` to `~/.local/share/orca-box/orca.sh` and links
one command per tool into `~/.local/bin`. Each acts on the name it is called by:

| Command | What it does |
| --- | --- |
| `orca-box AGENT [ARGS]` | run an agent in the current workspace's box |
| `orca-box-login` | sign in to the agents once, for every box |
| `orca-box-archive [--all]` | remove boxes now instead of waiting for idle |
| `orca-box-configure-orca` | point Orca's agents at `orca-box` (or `--unset`) |
| `orca-box-install-orca` | install/update the Orca app + menu entry |
| `orca-box-update` | update `orca-box` from this repository |
| `orca-box-setup` | the installer itself |

## How it works

Each Orca workspace gets its own container, built from
[`src/container/Containerfile`](src/container/Containerfile). The container
sees:

- the worktree, read-write, at the same path as on the host
- the repo's shared `.git` directory, **read-only by default**; with
  `ORCA_BOX_GIT=rw` agents may stage and commit, while everything git could
  later be made to *execute* on the host stays read-only
- a named volume used as `$HOME`, shared by all boxes (so logins are shared)
- your host's skills, read-only, added to the box's own
- the GitHub CLI; with `ORCA_BOX_GH_AUTH=1` it also gets your `gh` credentials

It cannot see the rest of your home directory, `~/.ssh`, or other repos.

### The container engine

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
orca.sh                  the generated single file (what people run)
build.sh                 assembles orca.sh from src/
src/
  header.sh              the file's header comment
  globals.sh             paths and globals
  dispatch.sh            name -> command
  lib/
    common.sh            config, output, downloads, engine detection
    box.sh               the box itself, plus archive and login
    configure-orca.sh    talks to Orca's local socket
    install-orca.sh      the Orca AppImage and its menu entry
    update.sh            self-update
    setup.sh             the installer
  python/                the helper programs Orca's socket and releases need
  container/             the Containerfile and the skill-sync script
tests/                   the test suite
```

### Editing

`orca.sh` is generated — **edit `src/`, not `orca.sh`**. After changing
anything:

```sh
./build.sh          # regenerate orca.sh
./build.sh --check  # verify it is up to date (CI does this)
```

The Python helpers in `src/python/` are referenced from the shell by an
`@@FILE:path@@` marker; `build.sh` expands each marker back into the file's
contents, so the shipped file stays self-contained and can still be piped to
`bash`.

## Development

```sh
./build.sh            # rebuild orca.sh
./build.sh --check    # check it is up to date
shellcheck orca.sh    # lint the built file
tests/run.sh          # run the test suite
```

The tests use a mock container engine and a mock Orca daemon, so they need
neither Podman nor Orca installed.

## License

MIT. See [LICENSE](LICENSE).
