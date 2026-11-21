#!/usr/bin/env bash
# orca.sh — Orca + orca-box in one file.
#
# Run Claude Code, Codex and pi from Orca (https://orca.dev) inside a separate
# container per workspace (Podman, or Docker), so agents can run without
# permission prompts without reaching the rest of your machine. Installs the
# Orca app too, with an application-menu entry.
#
# Recommended public-Gist usage (download, review, then run):
#   curl -fsSLO https://gist.githubusercontent.com/ggpwnkthx/f760bea3b776734133a2508bd6d21619/raw/orca.sh
#   less orca.sh
#   bash orca.sh --git=rw --yolo
#
# One-liner (pipe directly to bash):
#   curl -fsSL https://gist.githubusercontent.com/ggpwnkthx/f760bea3b776734133a2508bd6d21619/raw/orca.sh | bash
#
# One-liner with options (everything after "--" goes to the script):
#   curl -fsSL https://gist.githubusercontent.com/ggpwnkthx/f760bea3b776734133a2508bd6d21619/raw/orca.sh | bash -s -- --git=rw --yolo
#
# Options (all optional; full list with: bash orca.sh --help):
#   --git=rw   let agents stage and commit (default: read-only .git)
#   --yolo     set Claude Code, Codex and pi to Orca's Yolo permission mode
#              (no prompts; the container is the boundary)
#
# Run as your normal user, not with sudo. Keep Orca open, or let the installer
# start it: Orca has to be running for its agent settings to change.
# The URL above always serves the gist's latest revision.
#
# Installing copies this file to ~/.local/share/orca-box/orca.sh and links
# these commands in ~/.local/bin to it; each acts on the name it's called by:
#   orca-box AGENT [ARGS]      run an agent in the current workspace's box
#                              (what Orca's Claude Code/Codex/pi commands run)
#   orca-box-login             sign in to the agents once, for every box
#   orca-box-archive [--all]   remove boxes now instead of waiting for idle
#   orca-box-configure-orca    point Orca's agents at orca-box (or --unset)
#   orca-box-install-orca      install/update the Orca app + menu entry
#   orca-box-update            update orca-box from the gist (--check,
#                              --agents, --orca, --restart, --enable-auto)
#   orca-box-setup             this installer (--update, --uninstall, ...)
# Before installing, the same tools are reachable as: bash orca.sh TOOL ...
# (e.g. bash orca.sh orca-box-install-orca --help). Each takes --help.
#
# Updating later: orca-box-update (this script, from the URL above);
# orca-box-update --agents --orca also refreshes the agent image and Orca;
# orca-box-update --enable-auto checks for script updates daily.
set -euo pipefail

# Where this script came from. Piped in (curl ... | bash) there is no file, so
# the installer fetches the copy it keeps from ORCA_BOX_SOURCE_URL instead.
ORCA_BOX_SOURCE_URL="${ORCA_BOX_SOURCE_URL:-https://gist.githubusercontent.com/ggpwnkthx/f760bea3b776734133a2508bd6d21619/raw/orca.sh}"
ORCA_BOX_SELF=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  ORCA_BOX_SELF="$(readlink -f "${BASH_SOURCE[0]}")"
fi
ORCA_BOX_BIN="${PREFIX:-$HOME/.local}/bin"
ORCA_BOX_TOOLS=(orca-box orca-box-archive orca-box-login orca-box-configure-orca orca-box-install-orca orca-box-update)

# ============================================================ shared library
ORCA_BOX_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/orca-box"
ORCA_BOX_SETTINGS_KEYS=(ORCA_BOX_GIT ORCA_BOX_IDLE_SECONDS ORCA_BOX_MEMORY ORCA_BOX_IMAGE ORCA_BOX_HOME_VOLUME ORCA_BOX_SKILLS ORCA_BOX_GH_AUTH)

# Load ~/.config/orca-box/config: KEY=VALUE lines for the keys above.
# Environment variables win over the file; the file wins over defaults.
ob_load_config() {
  local file="$ORCA_BOX_CONFIG_DIR/config" key val known
  [ -r "$file" ] || return 0
  while IFS='=' read -r key val || [ -n "$key" ]; do
    known=0
    for k in "${ORCA_BOX_SETTINGS_KEYS[@]}"; do [ "$key" = "$k" ] && known=1; done
    [ "$known" = 1 ] || continue
    [ -n "${!key+x}" ] && continue
    printf -v "$key" '%s' "$val"
  done < "$file"
}

# Set KEY=VALUE in the config file, replacing any earlier line for KEY.
ob_set_config() {
  local file="$ORCA_BOX_CONFIG_DIR/config" tmp
  mkdir -p "$ORCA_BOX_CONFIG_DIR"
  tmp="$(mktemp "$ORCA_BOX_CONFIG_DIR/.config.XXXXXX")"
  { [ -r "$file" ] && grep -v "^$1=" "$file"; printf '%s=%s\n' "$1" "$2"; } > "$tmp" || true
  mv "$tmp" "$file"
}

ob_load_config
ORCA_BOX_IMAGE="${ORCA_BOX_IMAGE:-localhost/orca-agents:latest}"
ORCA_BOX_HOME_VOLUME="${ORCA_BOX_HOME_VOLUME:-orca-agent-home}"

# Print the engine mode: podman, docker or docker-rootless.
ob_detect_mode() {
  if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    echo podman
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; then
      echo docker-rootless
    else
      echo docker
    fi
  else
    return 1
  fi
}

ob_no_engine_help() {
  if command -v docker >/dev/null 2>&1; then
    cat >&2 <<'EOF'
orca-box: Docker is installed but not usable by your user. Start it with
  sudo systemctl enable --now docker
and add yourself to the docker group (sudo usermod -aG docker "$USER", then
log out and back in), or install Podman instead.
EOF
  elif command -v podman >/dev/null 2>&1; then
    echo "orca-box: podman is installed but 'podman info' fails; run it to see why." >&2
  else
    echo "orca-box: neither Podman nor Docker was found. Install one of them." >&2
  fi
}

# Set ENGINE (podman|docker) and OB_MODE (podman|docker|docker-rootless).
ob_init() {
  local want="${ORCA_BOX_ENGINE:-}" saved=""
  [ -r "$ORCA_BOX_CONFIG_DIR/engine" ] && read -r saved < "$ORCA_BOX_CONFIG_DIR/engine"

  if [ -n "$want" ]; then
    case "$want" in
      podman) OB_MODE=podman ;;
      docker)
        # Reuse the recorded rootless/rootful mode, else detect it.
        case "$saved" in
          docker*) OB_MODE="$saved" ;;
          *) OB_MODE=docker
             if docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; then
               OB_MODE=docker-rootless
             fi ;;
        esac ;;
      *) echo "orca-box: ORCA_BOX_ENGINE must be podman or docker" >&2; return 1 ;;
    esac
  elif [ -n "$saved" ]; then
    OB_MODE="$saved"
  else
    OB_MODE="$(ob_detect_mode)" || { ob_no_engine_help; return 1; }
  fi

  ENGINE="${OB_MODE%%-*}"
  command -v "$ENGINE" >/dev/null 2>&1 || {
    echo "orca-box: $ENGINE not found (recorded in $ORCA_BOX_CONFIG_DIR/engine); rerun orca-box-setup" >&2
    return 1
  }
}

# Run the engine.
# fd 9 is orca-box's per-workspace lock; never pass it on (podman's conmon
# would hold it for the container's whole life).
ob() { "$ENGINE" "$@" 9>&-; }

# User/identity flags for containers, in OB_USER_ARGS. Files the agents write
# in the worktree must end up owned by you on the host.
#   podman:          map your user onto the image's node user (UID 1000)
#   docker:          run as your own UID/GID
#   docker-rootless: container root *is* your user on the host; IS_SANDBOX=1
#                    lets Claude Code skip permissions as root (undocumented)
# shellcheck disable=SC2034,SC2054  # used by callers; comma is a podman option
ob_user_args() {
  case "$OB_MODE" in
    podman)          OB_USER_ARGS=(--userns=keep-id:uid=1000,gid=1000 --user 1000:1000) ;;
    docker)          OB_USER_ARGS=(--user "$(id -u):$(id -g)") ;;
    docker-rootless) OB_USER_ARGS=(--user 0:0 -e IS_SANDBOX=1) ;;
  esac
}

# Make the shared home volume writable by the user the agents run as. Only
# Docker needs this, and only when that user isn't the image's UID 1000.
ob_prepare_home() {
  local owner
  case "$OB_MODE" in
    docker)          owner="$(id -u):$(id -g)" ;;
    docker-rootless) owner="0:0" ;;
    *) return 0 ;;
  esac
  [ "$owner" = "1000:1000" ] && return 0
  # shellcheck disable=SC2016  # expanded by sh inside the container
  ob run --rm --user 0:0 -v "$ORCA_BOX_HOME_VOLUME:/home/node" "$ORCA_BOX_IMAGE" \
    sh -c '[ "$(stat -c %u:%g /home/node)" = "$1" ] || chown -R "$1" /home/node' _ "$owner" \
    >/dev/null
}

# Volume option for a bind mount: ob_mount_opt ro|rw. Adds SELinux relabeling
# (z) only on hosts that have SELinux.
ob_mount_opt() {
  local opts=""
  [ "$1" = ro ] && opts=ro
  if [ -e /sys/fs/selinux/enforce ]; then opts="${opts:+$opts,}z"; fi
  printf '%s' "${opts:+:$opts}"
}

# IDs of every orca-box container, found by label or by image.
ob_box_ids() {
  { ob ps -aq --filter label=orca.worktree
    ob ps -aq --filter "ancestor=$ORCA_BOX_IMAGE"
  } 2>/dev/null | sort -u
}

ob_worktree_of() {
  ob inspect -f '{{index .Config.Labels "orca.worktree"}}' "$1" 2>/dev/null
}

ob_name_of() {
  local n
  n="$(ob inspect -f '{{.Name}}' "$1" 2>/dev/null)" || n="$1"
  printf '%s' "${n#/}"
}

# Build the agent image from a folder holding the Containerfile.
#   ob_build DIR [--update]
ob_build() {
  local dir="$1" args=(-f "$1/Containerfile" -t "$ORCA_BOX_IMAGE")
  if [ "${2:-}" = --update ]; then
    if [ "$ENGINE" = podman ]; then args+=(--pull=always --no-cache)
    else args+=(--pull --no-cache); fi
  fi
  ob build "${args[@]}" "$dir"
}

# ============================================================ agent image
ob_containerfile() {
  cat <<'CONTAINERFILE'
# Image shared by every per-worktree agent container.
# Built by orca.sh as localhost/orca-agents:latest (orca-box-setup --update to refresh).
FROM docker.io/library/node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git ripgrep fd-find jq python3 python3-venv build-essential ca-certificates curl less \
 && rm -rf /var/lib/apt/lists/*

# Claude Code, Codex and pi, installed system-wide so the shared $HOME volume
# doesn't hide them. Rebuild the image to update (auto-updaters can't write here).
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent \
 && npm install -g @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force

# GitHub CLI, for agents that work with issues, pull requests and gists. From
# the official release (Debian's package is years behind). Pinned, so the
# build is reproducible: bump the version and the checksum to update.
ARG GH_VERSION=2.105.0
RUN curl -fsSL -o /tmp/gh.tar.gz \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
 && echo "79e7ab5db738c48777b696e374f8b428f0647debfb424f44d2f426370407fe2f  /tmp/gh.tar.gz" | sha256sum -c - \
 && tar -xzf /tmp/gh.tar.gz -C /tmp \
 && install -m 0755 "/tmp/gh_${GH_VERSION}_linux_amd64/bin/gh" /usr/local/bin/gh \
 && rm -rf /tmp/gh.tar.gz "/tmp/gh_${GH_VERSION}_linux_amd64"

ENV DISABLE_AUTOUPDATER=1

# The node image's "node" user is UID 1000; orca-box maps your host user onto it.
USER node
WORKDIR /home/node
CONTAINERFILE
}

# ============================================================ host skills
# The folders the agents read skills from, on the host and in the box.
ORCA_BOX_SKILL_DIRS=(.agents/skills .claude/skills .codex/skills .pi/agent/skills)

# The script that links the host's skills into the box. It runs inside the
# box, where the host's skill folders are mounted: it always sees them as
# they are now, so a skill installed on the host turns up in a box that is
# already running. Cheap on purpose - the box runs it every few seconds.
ob_skill_sync_script() {
  sed "s|@SKILL_DIRS@|${ORCA_BOX_SKILL_DIRS[*]}|" <<'EOF'
# Link the host's skills into the folders the agents read. $1 is the host's
# home folder, where the skill folders are mounted.
host="$1"
for d in @SKILL_DIRS@; do
  src="$host/$d"
  dst="$HOME/$d"
  [ -d "$src" ] || continue
  mkdir -p "$dst" 2>/dev/null || continue
  for s in "$src"/*; do
    [ -d "$s" ] || continue
    name="${s##*/}"
    case "$name" in .*) continue ;; esac
    t="$dst/$name"
    if [ -L "$t" ]; then
      cur="$(readlink "$t")"
      case "$cur" in "$host"/*) ;; *) continue ;; esac
      [ "$cur" = "$s" ] && continue
    elif [ -e "$t" ]; then
      continue
    fi
    ln -sfn "$s" "$t" 2>/dev/null || true
  done
  # Skills gone from the host: drop the links that point at them.
  for t in "$dst"/*; do
    [ -L "$t" ] || continue
    cur="$(readlink "$t")"
    case "$cur" in "$host"/*) ;; *) continue ;; esac
    [ -e "$cur" ] || rm -f "$t" 2>/dev/null || true
  done
done
EOF
}

# ============================================================ orca-box
usage_box() {
  cat <<'USAGE'
orca-box — run a coding agent inside a container dedicated to the current
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
USAGE
}

cmd_box() {
GIT_MODE="${ORCA_BOX_GIT:-ro}"
case "$GIT_MODE" in ro|rw) ;; *) echo "orca-box: ORCA_BOX_GIT must be ro or rw" >&2; exit 2 ;; esac
# Empty (ORCA_BOX_MEMORY=) means no memory/process limits.
MEMORY="${ORCA_BOX_MEMORY-8g}"
# Stop and delete the box once no agent or shell has been running in it for
# this long. Closing or deleting a workspace in Orca ends its agents, so the
# box goes away on its own; the next agent launch recreates it.
IDLE_SECONDS="${ORCA_BOX_IDLE_SECONDS:-120}"

# PID 1 of each box: exit once it is the only process left for IDLE_SECONDS.
# shellcheck disable=SC2016
WATCHDOG='
trap "exit 0" TERM INT
step=15; limit=$(( (IDLE_SECONDS + step - 1) / step )); idle=0
while :; do
  sleep "$step" & wait $!
  # Link in skills installed on the host since the box started: $1 is the
  # script, $2 the host home folder it reads them from.
  [ -n "$1" ] && bash -c "$1" _ "$2" >/dev/null 2>&1
  procs=(/proc/[0-9]*)
  if [ "${#procs[@]}" -le 1 ]; then idle=$((idle + 1)); else idle=0; fi
  [ "$idle" -ge "$limit" ] && exit 0
done'

[ "$#" -gt 0 ] || { echo "usage: orca-box <agent> [args...]" >&2; exit 2; }
ob_init

# Orca runs the agent command in two ways: in a terminal tab (interactive),
# and in the background for model lists, chat and commit messages, where it
# talks to the agent as JSON over plain pipes. Only ask for a terminal when
# we have one, or that JSON gets mangled.
if [ -t 0 ] && [ -t 1 ]; then
  io=(-it -e "TERM=${TERM:-xterm-256color}" -e "COLORTERM=${COLORTERM:-truecolor}")
else
  io=(-i)
fi

# ORCA_BOX_MEMORY= (empty) drops the limits, for hosts without cgroup
# delegation (some rootless Docker setups refuse them).
limits=()
[ -n "$MEMORY" ] && limits=(--pids-limit 4096 --memory "$MEMORY")

# Remove boxes whose worktree no longer exists (deleted workspaces).
for id in $(ob ps -aq --filter label=orca.worktree 2>/dev/null); do
  path="$(ob_worktree_of "$id")"
  if [ -n "$path" ] && [ ! -d "$path" ]; then
    ob rm -f "$id" >/dev/null 2>&1 || true
  fi
done

# Which folder to give the box:
#   git repo/worktree        -> that worktree (+ .git per ORCA_BOX_GIT)
#   other folder under ~     -> that folder only (Orca folder workspaces)
#   ~ itself, a ~/.dotdir, or anywhere outside ~ -> nothing: a throwaway box
#     with no host files, enough for Orca's background checks
here="$(pwd -P)"
home_real="$(cd "$HOME" && pwd -P)"
common=""
if wt="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  common="$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir)"
else
  case "$here/" in
    "$home_real/" | "$home_real"/.*) wt="" ;;
    "$home_real"/?*) wt="$here" ;;
    *) wt="" ;;
  esac
fi

ob_user_args

# Skills installed on the host (npx skills, or by hand) go into the box
# read-only: everything in ~/.agents/skills, ~/.claude/skills, ~/.codex/skills
# and ~/.pi/agent/skills. Each of those folders is mounted whole, at the path
# it has on the host, so the box sees what the host has right now: a skill
# installed while the box runs shows up in it, no restart needed. The box
# links every host skill into the folder its agent reads (as a symlink, so
# the skills already in the box's own home volume stay visible), and drops
# the link when the skill goes away on the host. Read-only, so an agent
# can't plant code in a skill that every other box would then run. Links
# (npx skills links each agent's folder to its shared store, ~/.agents/skills)
# keep working: they are mounted where they are, so they resolve inside the
# box as they do outside it.
# ORCA_BOX_SKILLS=0 turns this off.
skill_mounts=() skill_sync=""
if [ "${ORCA_BOX_SKILLS:-1}" != 0 ]; then
  sro="$(ob_mount_opt ro)"
  for d in "${ORCA_BOX_SKILL_DIRS[@]}"; do
    src="$HOME/$d"
    if [ ! -d "$src" ]; then
      # The mount has to exist when the box starts: make the folder on the
      # host if its parent is there, so skills installed later still arrive.
      parent="${d%/*}"
      if [ "$parent" = "$d" ]; then parent="."; fi
      [ -d "$HOME/$parent" ] || continue
      mkdir -p "$src" 2>/dev/null || continue
    fi
    skill_mounts+=(-v "$src:$src$sro")
    # A skill kept outside those folders (a link out of the shared store):
    # mount it where it belongs. Rare, and fixed when the box starts.
    for entry in "$src"/*; do
      skill="${entry##*/}"
      case "$skill" in *:* | *,* | .*) continue ;; esac  # can't be expressed in -v
      real="$(readlink -f "$entry" 2>/dev/null)" || continue
      [ -d "$real" ] || continue  # skills are folders; skip stray files, broken links
      case "$real" in "$HOME"/*/skills/*) continue ;; esac  # already mounted
      skill_mounts+=(-v "$real:/home/node/$d/$skill$sro")
    done
  done
  skill_sync="$(ob_skill_sync_script)"
fi

# Your gh credentials, so agents can use the host's gh login (opt-in:
# ORCA_BOX_GH_AUTH=1). The config folder is mounted read-only: an agent
# cannot add or change credentials, but it can read the token in there, so
# this hands your GitHub token to everyone who runs in the box.
gh_mounts=() gh_env=()
if [ "${ORCA_BOX_GH_AUTH:-0}" = 1 ]; then
  gh_dir="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
  if [ -d "$gh_dir" ]; then
    gh_mounts+=(-v "$gh_dir:/home/node/.config/gh$(ob_mount_opt ro)")
  fi
  # A token in the environment instead of in gh's config folder.
  for v in GH_TOKEN GITHUB_TOKEN; do
    if [ -n "${!v:-}" ]; then gh_env+=(-e "$v"); fi
  done
fi

if [ -z "$wt" ]; then
  ob_prepare_home
  exec "$ENGINE" run --rm "${io[@]}" --label orca.scratch=1 \
    "${OB_USER_ARGS[@]}" \
    --cap-drop=all --security-opt no-new-privileges \
    "${limits[@]}" \
    -v "$ORCA_BOX_HOME_VOLUME:/home/node" -e HOME=/home/node -w /home/node \
    "${skill_mounts[@]}" "${gh_mounts[@]}" "${gh_env[@]}" \
    "$ORCA_BOX_IMAGE" bash -c 'bash -c "$1" _ "$2" >/dev/null 2>&1; shift 2; exec "$@"' \
      _ "$skill_sync" "$HOME" "$@"
fi

slug="$(printf '%s' "${wt##*/}" | tr -c 'A-Za-z0-9_.-' '-' | cut -c1-40)"
name="orca-${slug}-$(printf '%s' "$wt" | sha1sum | cut -c1-8)"

# Orca often starts several agent processes for one workspace at once; only
# one of them may create the box.
if [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -d "$XDG_RUNTIME_DIR" ]; then
  lockdir="$XDG_RUNTIME_DIR/orca-box"
else
  lockdir="/tmp/orca-box-$(id -u)"
fi
mkdir -m 700 "$lockdir" 2>/dev/null || true
if [ -L "$lockdir" ] || [ ! -d "$lockdir" ] || [ ! -O "$lockdir" ]; then
  echo "orca-box: lock folder $lockdir isn't a private folder of yours" >&2
  exit 1
fi
# "true 2 <git mode>" for a running, current box; anything else needs (re)creating.
box_state() {
  ob inspect -f '{{.State.Running}} {{index .Config.Labels "orca.box"}} {{index .Config.Labels "orca.git"}}' \
    "$name" 2>/dev/null || true
}
lock_timeout="${ORCA_BOX_LOCK_TIMEOUT:-60}"
lockfile="$lockdir/$name.lock"
need_create=0
state="$(box_state)"
case "$state" in
  "true 2 "*) ;;  # running: just use it, no lock needed
  *)
    exec 9>"$lockfile"
    if flock -w "$lock_timeout" 9; then
      state="$(box_state)"  # another launch may have made it while we waited
      case "$state" in
        "true 2 "*) ;;
        *) [ -z "$state" ] || ob rm -f "$name" >/dev/null 2>&1 || true
           state="" need_create=1 ;;
      esac
    else
      exec 9>&-
      state="$(box_state)"
      case "$state" in
        "true 2 "*) ;;  # the other launch finished; use its box
        *)
          echo "orca-box: timed out after ${lock_timeout}s waiting for another launch in this workspace." >&2
          echo "orca-box: what holds the lock: ls -l /proc/[0-9]*/fd 2>/dev/null | grep -F '$lockfile'" >&2
          exit 1 ;;
      esac
    fi ;;
esac

# The whole creation step runs with fd 9 hidden from child processes (bash
# keeps a close-on-exec copy, so we still hold the lock): nothing started
# here (podman's conmon, git's fsmonitor daemon...) may keep it.
if [ "$need_create" = 1 ]; then {
  rw="$(ob_mount_opt rw)" ro="$(ob_mount_opt ro)"
  mounts=(-v "$wt:$wt$rw")
  git_env=()
  if [ -z "$common" ]; then
    :  # not a git repo: just the folder
  elif [ "$GIT_MODE" = rw ]; then
    # Agents may stage and commit, so objects, refs, logs and this worktree's
    # own index/HEAD are writable. Read-only: everything git could later be
    # made to *execute* on the host, or that belongs to other worktrees:
    #   hooks/, config (core.hooksPath, core.fsmonitor, filter drivers,
    #   aliases), info/ (attributes, grafts), refs/tags, other worktrees'
    #   folders, and this worktree's config.worktree when the repo uses them.
    gitdir="$(git -C "$wt" rev-parse --path-format=absolute --git-dir)"
    mounts+=(-v "$common:$common$rw")
    for p in hooks config info refs/tags; do
      [ -e "$common/$p" ] && mounts+=(-v "$common/$p:$common/$p$ro")
    done
    if [ -d "$common/worktrees" ]; then
      mounts+=(-v "$common/worktrees:$common/worktrees$ro")
      if [ "$gitdir" != "$common" ]; then
        mounts+=(-v "$gitdir:$gitdir$rw")
        if [ "$(git -C "$wt" config --bool extensions.worktreeConfig 2>/dev/null)" = true ]; then
          [ -e "$gitdir/config.worktree" ] || : > "$gitdir/config.worktree"
          mounts+=(-v "$gitdir/config.worktree:$gitdir/config.worktree$ro")
        fi
      fi
    fi
    # Commit as you: your global ~/.gitconfig isn't in the box.
    for k in name email; do
      v="$(git -C "$wt" config "user.$k" 2>/dev/null || true)"
      [ -n "$v" ] || continue
      K="$(printf '%s' "$k" | tr '[:lower:]' '[:upper:]')"
      git_env+=(-e "GIT_AUTHOR_$K=$v" -e "GIT_COMMITTER_$K=$v")
    done
    # No automatic gc/maintenance: it would try to rewrite read-only parts.
    git_env+=(-e GIT_CONFIG_COUNT=2
              -e GIT_CONFIG_KEY_0=gc.auto -e GIT_CONFIG_VALUE_0=0
              -e GIT_CONFIG_KEY_1=maintenance.auto -e GIT_CONFIG_VALUE_1=false)
  else
    mounts+=(-v "$common:$common$ro")
  fi

  ob_prepare_home
  ob run -d --rm --name "$name" \
    --label "orca.worktree=$wt" --label orca.box=2 --label "orca.git=$GIT_MODE" \
    "${OB_USER_ARGS[@]}" \
    --cap-drop=all --security-opt no-new-privileges \
    "${limits[@]}" \
    -v "$ORCA_BOX_HOME_VOLUME:/home/node" -e HOME=/home/node \
    "${skill_mounts[@]}" "${gh_mounts[@]}" "${gh_env[@]}" "${mounts[@]}" -w "$wt" \
    -e IDLE_SECONDS="$IDLE_SECONDS" "${git_env[@]}" \
    "$ORCA_BOX_IMAGE" bash -c "$WATCHDOG" _ "$skill_sync" "$HOME" >/dev/null
} 9>&-
fi
exec 9>&-

case "$state" in
  "true 2 $GIT_MODE" | "") ;;
  "true 2 "*)
    # Agents may be running in it; don't pull the box out from under them.
    echo "orca-box: this workspace's box was started with ORCA_BOX_GIT=${state##* }." >&2
    echo "orca-box: the new setting ($GIT_MODE) applies once the box goes idle, or run orca-box-archive here." >&2 ;;
esac

# Skills installed on the host since this box started: link them in now, so
# the agent sees them without waiting for the box's next sweep.
if [ -n "$skill_sync" ]; then
  ob exec "$name" bash -c "$skill_sync" _ "$HOME" >/dev/null 2>&1 || true
fi

exec "$ENGINE" exec "${io[@]}" -w "$here" "$name" "$@"
}

# ============================================================ orca-box-archive
usage_archive() {
  cat <<'USAGE'
orca-box-archive — remove agent boxes right away instead of waiting for
them to go idle.

  orca-box-archive          remove the box for the current worktree, plus
                            any box whose worktree folder no longer exists
  orca-box-archive --all    remove every orca-box container

Optional as Orca's Archive Script; boxes also remove themselves when idle.
Only touches containers made from the orca-agents image or carrying the
orca.worktree label, never your other containers.
USAGE
}

cmd_archive() {
set +e
ob_init || exit 1

remove() {
  echo "removing $(ob_name_of "$1")"
  ob rm -f "$1" >/dev/null
}

if [ "${1:-}" = --all ]; then
  for id in $(ob_box_ids); do remove "$id"; done
  exit 0
fi

wt="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
for id in $(ob_box_ids); do
  path="$(ob_worktree_of "$id")"
  if [ -z "$path" ] || [ "$path" = "$wt" ] || [ ! -d "$path" ]; then
    remove "$id"
  fi
done
exit 0
}

# ============================================================ orca-box-login
usage_login() {
  cat <<'USAGE'
orca-box-login — sign in to Claude Code, Codex and pi once, for every box.

  orca-box-login            open a shell; run `claude` (/login),
                            `codex login`, `pi` (/login), then `exit`
  orca-box-login claude     start one agent directly to sign in

Logins are saved in the shared home volume that every orca-box container
mounts. This one-off container uses the host network so browser logins that
call back to localhost (e.g. Codex on port 1455) work; your workspace boxes
keep their own isolated network.
USAGE
}

cmd_login() {
ob_init
ob_user_args
ob_prepare_home

[ "$#" -gt 0 ] || set -- bash

exec "$ENGINE" run --rm -it --network=host \
  "${OB_USER_ARGS[@]}" \
  --cap-drop=all --security-opt no-new-privileges \
  -v "$ORCA_BOX_HOME_VOLUME:/home/node" -e HOME=/home/node -w /home/node \
  -e TERM="${TERM:-xterm-256color}" \
  "$ORCA_BOX_IMAGE" "$@"
}

# ============================================================ orca-box-configure-orca
usage_configure_orca() {
  cat <<'USAGE'
orca-box-configure-orca — point Orca's built-in Claude Code, Codex and pi
agents at orca-box, so launching them from Orca runs them in a box.

  orca-box-configure-orca           set the command for claude, codex, pi
  orca-box-configure-orca --yolo    also set those agents' permissions to
                                    "Yolo" (safe here: the box is the limit)
  orca-box-configure-orca --unset   put back the commands these agents had
                                    before (only where they still point at
                                    orca-box)

This is the same setting as Settings → Agents → <agent> → Command. It talks
to the running Orca app over its private local socket, the way Orca's own
`orca` CLI does, so Orca applies and saves the change itself. Orca must be
running; nothing is written to Orca's files directly.
USAGE
}

cmd_configure_orca() {
BIN="$ORCA_BOX_BIN"
action=set yolo=0
for arg in "$@"; do
  case "$arg" in
    --unset) action="unset" ;;
    --yolo)  yolo=1 ;;
    -h|--help) usage_configure_orca; exit 0 ;;
    *) echo "unknown option: $arg (see --help)" >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null || {
  echo "orca-box-configure-orca: python3 not found; set the commands by hand in Orca." >&2
  exit 4
}

# Exit codes: 0 done, 3 Orca not running/reachable, 1 Orca rejected a change.
SAVED="${XDG_CONFIG_HOME:-$HOME/.config}/orca-box/orca-previous-commands.json"
# Orca adds ~/.local/bin to its own PATH, so the bare name works for terminal
# tabs and background jobs alike, and is the same on every machine. A literal
# "~" would not work: Orca runs background jobs without a shell. With a custom
# PREFIX, Orca can't find the bare name, so use the full path.
if [ "$(readlink -f "$BIN")" = "$(readlink -f "$HOME/.local/bin")" ]; then
  prefix="orca-box"
else
  prefix="$BIN/orca-box"
fi
exec python3 -I - "$action" "$yolo" "$BIN/orca-box" "$SAVED" "$prefix" <<'PY'
import json, os, socket, stat, sys, uuid

action, yolo, box, saved_path, prefix = (
    sys.argv[1], sys.argv[2] == "1", sys.argv[3], sys.argv[4], sys.argv[5])
AGENTS = ["claude", "codex", "pi"]

def fail(code, msg):
    print(f"orca-box-configure-orca: {msg}", file=sys.stderr)
    sys.exit(code)

# Orca's user-data folder, as its own CLI resolves it on Linux.
user_data = os.environ.get("ORCA_USER_DATA_PATH") or os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "orca")
meta_path = os.path.join(user_data, "orca-runtime.json")
try:
    with open(meta_path) as f:
        meta = json.load(f)
except (OSError, ValueError):
    fail(3, f"Orca isn't running (no {meta_path}). Start Orca and run this again.")

try:
    os.kill(int(meta.get("pid", 0)), 0)
except ProcessLookupError:
    fail(3, "Orca isn't running (stale runtime file). Start Orca and run this again.")
except (PermissionError, ValueError, TypeError):
    pass

transports = meta.get("transports")
if not isinstance(transports, list):
    transports = [meta.get("transport")] if meta.get("transport") else []
endpoint = next((t.get("endpoint") for t in transports
                 if isinstance(t, dict) and t.get("kind") == "unix"), None)
token = meta.get("authToken")
if not endpoint or not token:
    fail(3, f"Orca's runtime file {meta_path} has no local socket or token.")

# Like Orca's CLI: never send the token to a socket in a /tmp folder that
# isn't private to this user.
uid = os.getuid()
short_prefix = f"/tmp/.orca-daemon-{uid}/"
if endpoint.startswith(short_prefix):
    for d in (os.path.dirname(endpoint), os.path.dirname(os.path.dirname(endpoint))):
        st = os.lstat(d)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or st.st_mode & 0o077:
            fail(3, f"Orca's socket folder {d} isn't private to you; not connecting.")

def call(method, params=None):
    rid = str(uuid.uuid4())
    msg = {"id": rid, "authToken": token, "method": method}
    if params is not None:
        msg["params"] = params
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(15)
        s.connect(endpoint)
        s.sendall((json.dumps(msg) + "\n").encode())
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                fail(3, "Orca closed the connection before answering. Try again.")
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                frame = json.loads(line)
                if "_keepalive" in frame or frame.get("id") != rid:
                    continue
                s.close()
                return frame
    except (OSError, socket.timeout) as e:
        fail(3, f"couldn't reach Orca ({e}). Is it running?")

def current_overrides():
    frame = call("settings.getAgentLaunch")
    if not frame.get("ok"):
        return None
    settings = (frame.get("result") or {}).get("settings") or {}
    overrides = settings.get("agentCmdOverrides")
    return overrides if isinstance(overrides, dict) else {}

def mutate(params):
    frame = call("settings.mutateAgentLaunch", params)
    if not frame.get("ok"):
        err = frame.get("error") or {}
        fail(1, f"Orca rejected {params}: {err.get('message') or err}")

def is_ours(value):
    """Our command in any form we've written: orca-box, ~/.local/bin/orca-box,
    or a full path (including Bazzite's /var/home form)."""
    first = value.split(" ", 1)[0] if value else ""
    if not first:
        return False
    if first == "orca-box":
        return True
    return os.path.realpath(os.path.expanduser(first)) == os.path.realpath(box)

# Commands the agents had before orca-box took over, restored by --unset.
try:
    with open(saved_path) as f:
        saved = json.load(f)
    if not isinstance(saved, dict):
        saved = {}
except (OSError, ValueError):
    saved = {}

before = current_overrides()
failed = False
if action == "set" and before is not None:
    for agent in AGENTS:
        old = before.get(agent, "")
        if not is_ours(old):
            saved[agent] = old
    os.makedirs(os.path.dirname(saved_path), exist_ok=True)
    with open(saved_path, "w") as f:
        json.dump(saved, f, indent=2)

for agent in AGENTS:
    old = (before or {}).get(agent, "")
    if action == "set":
        new = f"{prefix} {agent}"
        mutate({"type": "command", "agent": agent, "value": new})
        print(f"  {agent:7} command: {old or '(default)'} -> {new}")
        if yolo:
            mutate({"type": "permissions", "mode": "yolo", "agent": agent})
            print(f"  {agent:7} permissions: Yolo")
    else:
        if before is None:
            print(f"  {agent:7} skipped (couldn't read current setting)")
            failed = True
        elif is_ours(old):
            prev = saved.get(agent, "") if isinstance(saved.get(agent, ""), str) else ""
            mutate({"type": "command", "agent": agent, "value": prev})
            print(f"  {agent:7} command: {old} -> {prev or '(default)'}")
        else:
            print(f"  {agent:7} left as {old or '(default)'}")
if action == "unset" and not failed:
    try:
        os.remove(saved_path)
    except OSError:
        pass
sys.exit(1 if failed else 0)
PY
}

# ============================================================ orca-box-install-orca
usage_install_orca() {
  cat <<'USAGE'
orca-box-install-orca — install or update the Orca app (AppImage) and add it
to your application menu.

  orca-box-install-orca              download the latest release from
                                     github.com/stablyai/orca, verify it,
                                     install it and add the menu entry
  orca-box-install-orca --from FILE  install an AppImage you downloaded
                                     yourself (e.g. from orca.dev)
  orca-box-install-orca --remove     remove the installed app and menu entry
                                     (keeps Orca's settings in ~/.config/orca)

Installs to ~/AppImages/orca.AppImage (Gear Lever's default folder; change
with ORCA_APPIMAGE_DIR). The file stays writable by you so Orca's built-in
updater can keep updating it in place.

The download is checked against the SHA-256 digest GitHub publishes for the
file, or else the SHA-512 in the release's latest-linux.yml (what Orca's own
updater uses). With neither available it refuses, unless
ORCA_BOX_ALLOW_UNVERIFIED=1.
USAGE
}

cmd_install_orca() {
REPO="stablyai/orca"
DIR="${ORCA_APPIMAGE_DIR:-$HOME/AppImages}"
DEST="$DIR/orca.AppImage"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor"
DESKTOP_ID="orca-ide"
DESKTOP_FILE="$APPS/$DESKTOP_ID.desktop"
GITHUB_API="${ORCA_BOX_GITHUB_API:-https://api.github.com}"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

action=install from=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) from="${2:?--from needs a file}"; shift ;;
    --remove) action=remove ;;
    -h|--help) usage_install_orca; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

# Tell desktop environments about the change. (No icon-theme.cache in your
# own icon folder: one that goes stale hides other apps' new icons.)
refresh_menus() {
  if command -v update-desktop-database >/dev/null; then
    update-desktop-database -q "$APPS" 2>/dev/null || true
  fi
  for k in kbuildsycoca6 kbuildsycoca5; do
    if command -v "$k" >/dev/null; then
      "$k" >/dev/null 2>&1 || true
      break
    fi
  done
  return 0
}

if [ "$action" = remove ]; then
  if [ -f "$DESKTOP_FILE" ] && ! grep -q '^X-Orca-Box=true' "$DESKTOP_FILE"; then
    warn "$DESKTOP_FILE wasn't created by orca-box; leaving it"
  else
    rm -f "$DESKTOP_FILE"
  fi
  find "$ICONS" -path "*/apps/$DESKTOP_ID.*" -delete 2>/dev/null || true
  rm -f "$DEST"
  refresh_menus
  say "Removed $DEST and its menu entry (Orca's settings in ~/.config/orca are untouched)."
  exit 0
fi

command -v python3 >/dev/null || die "python3 is required"
case "$(uname -m)" in
  x86_64|amd64)  asset="orca-linux.AppImage";       yml="latest-linux.yml" ;;
  aarch64|arm64) asset="orca-linux-arm64.AppImage"; yml="latest-linux-arm64.yml" ;;
  *) die "no Orca AppImage for $(uname -m)" ;;
esac

mkdir -p "$DIR"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

dl() {  # dl URL FILE
  curl -fL --proto '=https' --tlsv1.2 --retry 3 --connect-timeout 20 \
    -H 'User-Agent: orca-box-installer' -o "$2" "$1"
}

version=""
if [ -n "$from" ]; then
  [ -f "$from" ] || die "no such file: $from"
  cp "$from" "$work/new.AppImage"
  say "Installing $from"
else
  say "Looking up the latest Orca release"
  dl "$GITHUB_API/repos/$REPO/releases/latest" "$work/release.json" 2>/dev/null ||
    die "couldn't reach GitHub's API. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE"
  # tag, AppImage URL, its sha256 (may be empty), latest-linux.yml URL (may be empty)
  mapfile -t info < <(python3 -I - "$work/release.json" "$asset" "$yml" <<'PY'
import json, sys
rel = json.load(open(sys.argv[1]))
assets = {a.get("name"): a for a in rel.get("assets") or []}
app, yml = assets.get(sys.argv[2]) or {}, assets.get(sys.argv[3]) or {}
digest = app.get("digest") or ""
print(rel.get("tag_name") or "")
print(app.get("browser_download_url") or "")
print(digest.split(":", 1)[1] if digest.startswith("sha256:") else "")
print(yml.get("browser_download_url") or "")
PY
  )
  version="${info[0]:-}" url="${info[1]:-}" sha256="${info[2]:-}" yml_url="${info[3]:-}"
  [ -n "$url" ] || die "release ${version:-latest} has no $asset. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE"

  # Already have exactly this build? (Orca's updater may have got there first.)
  if [ -n "$sha256" ] && [ -f "$DEST" ] && [ "$(sha256sum "$DEST" | cut -d' ' -f1)" = "$sha256" ]; then
    say "Orca $version is already installed at $DEST"
    skip_download=1
  fi

  if [ -z "${skip_download:-}" ]; then
    say "Downloading Orca $version ($asset)"
    dl "$url" "$work/new.AppImage"
    if [ -n "$sha256" ]; then
      [ "$(sha256sum "$work/new.AppImage" | cut -d' ' -f1)" = "$sha256" ] ||
        die "SHA-256 of the download doesn't match GitHub's digest; not installing"
      say "Verified SHA-256 against GitHub's digest"
    elif [ -n "$yml_url" ] && dl "$yml_url" "$work/latest.yml" 2>/dev/null; then
      python3 -I - "$work/latest.yml" "$asset" "$work/new.AppImage" <<'PY' ||
import base64, hashlib, sys
lines = open(sys.argv[1]).read().splitlines()
want, current = None, None
for line in lines:
    s = line.strip().lstrip("- ").strip()
    if s.startswith("url:"):
        current = s.split(":", 1)[1].strip().strip("'\"")
    elif s.startswith("sha512:") and current == sys.argv[2]:
        want = s.split(":", 1)[1].strip().strip("'\"")
        break
if not want:
    sys.exit("no sha512 for this file in latest-linux.yml")
h = hashlib.sha512()
with open(sys.argv[3], "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
sys.exit(0 if base64.b64encode(h.digest()).decode() == want else "sha512 mismatch")
PY
        die "the download doesn't match the SHA-512 in $yml; not installing"
      say "Verified SHA-512 against $yml"
    elif [ "${ORCA_BOX_ALLOW_UNVERIFIED:-0}" = 1 ]; then
      warn "no checksum published for $asset; installing unverified (ORCA_BOX_ALLOW_UNVERIFIED=1)"
    else
      die "no checksum published for $asset, so it can't be verified. Set ORCA_BOX_ALLOW_UNVERIFIED=1 to install anyway."
    fi
  fi
fi

if [ -f "$work/new.AppImage" ]; then
  head -c 4 "$work/new.AppImage" | grep -q $'^\x7fELF' || die "that file isn't an AppImage (not an ELF executable)"
  chmod 755 "$work/new.AppImage"
  # Same-folder rename: atomic, and a running Orca keeps its old copy open.
  tmp="$(mktemp "$DIR/.orca.AppImage.XXXXXX")"
  cp "$work/new.AppImage" "$tmp"
  chmod 755 "$tmp"
  mv -f "$tmp" "$DEST"
  say "Installed $DEST"
fi

# --- menu entry, from the .desktop file and icons inside the AppImage --------
say "Adding Orca to the application menu"
mkdir -p "$APPS"
(
  cd "$work"
  "$DEST" --appimage-extract '*.desktop' >/dev/null 2>&1 || true
  "$DEST" --appimage-extract 'usr/share/icons/*' >/dev/null 2>&1 || true
  "$DEST" --appimage-extract '.DirIcon' >/dev/null 2>&1 || true
)
root="$work/squashfs-root"

# Icons: every hicolor size the app ships, renamed to our desktop id.
found_icon=0
if [ -d "$root/usr/share/icons/hicolor" ]; then
  while IFS= read -r icon; do
    rel="${icon#"$root/usr/share/icons/hicolor/"}"   # e.g. 256x256/apps/orca-ide.png
    size="${rel%%/*}"
    mkdir -p "$ICONS/$size/apps"
    cp -L "$icon" "$ICONS/$size/apps/$DESKTOP_ID.${icon##*.}"
    found_icon=1
  done < <(find "$root/usr/share/icons/hicolor" -path '*/apps/*' \( -name '*.png' -o -name '*.svg' \))
fi
if [ "$found_icon" = 0 ] && [ -e "$root/.DirIcon" ]; then
  mkdir -p "$ICONS/256x256/apps"
  cp -L "$root/.DirIcon" "$ICONS/256x256/apps/$DESKTOP_ID.png"
  found_icon=1
fi
[ "$found_icon" = 1 ] || warn "couldn't extract Orca's icon; the menu entry will use a generic one"

if [ -f "$DESKTOP_FILE" ] && ! grep -q '^X-Orca-Box=true' "$DESKTOP_FILE"; then
  cp "$DESKTOP_FILE" "$DESKTOP_FILE.bak"
  warn "replaced an existing $DESKTOP_FILE (saved as $DESKTOP_FILE.bak)"
fi

embedded="$(find "$root" -maxdepth 1 -name '*.desktop' 2>/dev/null | head -n1)"
python3 -I - "$embedded" "$DESKTOP_FILE" "$DEST" "$DESKTOP_ID" "$version" <<'PY'
import re, shlex, sys
embedded, out, dest, icon, version = sys.argv[1:6]
lines = []
if embedded:
    try:
        lines = open(embedded, encoding="utf-8").read().splitlines()
    except OSError:
        lines = []
if not any(l.strip() == "[Desktop Entry]" for l in lines):
    lines = ["[Desktop Entry]", "Type=Application", "Name=Orca",
             "Comment=Run a fleet of coding agents in parallel",
             "Exec=AppRun %U", "Terminal=false", "Categories=Development;Utility;",
             "StartupWMClass=orca"]
quoted = '"' + re.sub(r'(["`$\\])', r'\\\1', dest) + '"'
result, section = [], None
for l in lines:
    if l.startswith("["):
        section = l.strip()
    elif "=" in l:
        key, val = l.split("=", 1)
        k = key.strip()
        if k == "Exec":
            # Replace the program (AppRun) with the installed AppImage; keep its arguments.
            parts = val.strip().split(None, 1)
            l = "Exec=" + quoted + (" " + parts[1] if len(parts) > 1 else " %U")
        elif k == "TryExec" or k.startswith("X-AppImage") or k == "X-Orca-Box":
            continue
        elif k == "Icon":
            l = "Icon=" + icon
    result.append(l)
    if l.strip() == "[Desktop Entry]":
        result.append("TryExec=" + dest)
        result.append("X-Orca-Box=true")
        if version:
            result.append("X-AppImage-Version=" + version.lstrip("v"))
if not any(re.match(r"^Icon=", l) for l in result):
    i = result.index("[Desktop Entry]") + 1
    result.insert(i, "Icon=" + icon)
open(out, "w", encoding="utf-8").write("\n".join(result) + "\n")
PY
chmod 644 "$DESKTOP_FILE"
if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$DESKTOP_FILE" 2>&1 | sed 's/^/    /' >&2 || true
fi
refresh_menus
say "Menu entry: $DESKTOP_FILE"
}

# ============================================================ orca-box-update
usage_update() {
  cat <<'USAGE'
orca-box-update — update orca-box to the latest orca.sh from its gist (the
URL in orca.sh's header; ORCA_BOX_SOURCE_URL to use another copy).

  orca-box-update             update orca-box, keeping your settings
  orca-box-update --check     only say whether an update is available
  orca-box-update --agents    also rebuild the agent image with the latest
                              Claude Code, Codex and pi
  orca-box-update --orca      also update the Orca app
  orca-box-update --restart   afterwards, remove running boxes so they use the
                              update right away (stops agents running in them);
                              otherwise they switch once they go idle
  orca-box-update --enable-auto   check for and install orca-box updates daily
  orca-box-update --disable-auto  (a systemd user timer; script updates only,
                                  never restarts boxes or rebuilds the image)
  --quiet                     print only when something changed

The download must be valid bash and really be orca.sh before it's used; the
new version's own installer then installs it.
USAGE
}

cmd_update() {
local check=0 agents=0 orca=0 restart=0 quiet=0 auto=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) check=1 ;;
    --agents) agents=1 ;;
    --orca) orca=1 ;;
    --restart) restart=1 ;;
    --quiet) quiet=1 ;;
    --enable-auto) auto=on ;;
    --disable-auto) auto=off ;;
    -h|--help) usage_update; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { [ "$quiet" = 1 ] || printf '\033[1m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

local data="${XDG_DATA_HOME:-$HOME/.local/share}/orca-box"
local installed="$data/orca.sh"
local units="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

# --- daily automatic updates (systemd user timer) --------------------------
if [ "$auto" = on ]; then
  command -v systemctl >/dev/null || die "systemd isn't available; run orca-box-update yourself instead"
  mkdir -p "$units"
  cat > "$units/orca-box-update.service" <<UNIT
[Unit]
Description=Update orca-box from its gist
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$ORCA_BOX_BIN/orca-box-update --quiet
UNIT
  cat > "$units/orca-box-update.timer" <<'UNIT'
[Unit]
Description=Check for orca-box updates daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now orca-box-update.timer >/dev/null
  say "Daily orca-box updates are on (orca-box-update --disable-auto to stop)."
  say "They update the script only; see what they did: journalctl --user -u orca-box-update"
  exit 0
elif [ "$auto" = off ]; then
  if command -v systemctl >/dev/null; then
    systemctl --user disable --now orca-box-update.timer >/dev/null 2>&1 || true
  fi
  rm -f "$units/orca-box-update.service" "$units/orca-box-update.timer"
  command -v systemctl >/dev/null && systemctl --user daemon-reload 2>/dev/null || true
  say "Daily orca-box updates are off."
  exit 0
fi

# --- fetch and check the latest orca.sh ------------------------------------
command -v curl >/dev/null || die "curl not found"
mkdir -p "$data"
# Global, not local: the EXIT trap runs after this function has returned.
ORCA_BOX_UPDATE_TMP="$(mktemp "$data/.update.XXXXXX")"
trap 'rm -f "${ORCA_BOX_UPDATE_TMP:-}"' EXIT
local tmp="$ORCA_BOX_UPDATE_TMP"
curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$tmp" "$ORCA_BOX_SOURCE_URL" ||
  die "couldn't download $ORCA_BOX_SOURCE_URL"
if ! grep -q '^# orca.sh — Orca + orca-box in one file' "$tmp" || ! bash -n "$tmp"; then
  die "the download isn't a valid orca.sh; not updating"
fi

local old="(not installed)" new changed=1
new="$(sha256sum "$tmp" | cut -c1-12)"
if [ -f "$installed" ]; then
  old="$(sha256sum "$installed" | cut -c1-12)"
  cmp -s "$tmp" "$installed" && changed=0
fi

if [ "$check" = 1 ]; then
  if [ "$changed" = 1 ]; then
    local lines
    lines="$(diff "$installed" "$tmp" 2>/dev/null | grep -c '^[<>]' || true)"
    echo "Update available: $old -> $new (${lines:-?} lines differ). Run: orca-box-update"
  else
    echo "orca-box is up to date ($old)."
  fi
  exit 0
fi

if [ "$changed" = 0 ] && [ "$agents" = 0 ] && [ "$orca" = 0 ]; then
  say "orca-box is up to date ($old)."
  [ "$restart" = 0 ] || ( cmd_archive --all )
  exit 0
fi

# --- install via the new version's own installer ---------------------------
[ "$changed" = 0 ] || printf '\033[1m==>\033[0m Updating orca-box: %s -> %s\n' "$old" "$new"
local args=(--brief --no-launch --keep-boxes)
if [ "$agents" = 1 ]; then args+=(--update); else args+=(--no-build); fi
[ "$orca" = 1 ] || args+=(--no-orca-app)
if [ "$quiet" = 1 ]; then
  bash "$tmp" "${args[@]}" >/dev/null || die "the update's installer failed; run orca-box-update to see why"
else
  bash "$tmp" "${args[@]}" || die "the update's installer failed (see above)"
fi

if [ "$restart" = 1 ]; then
  say "Removing running boxes so the next launch uses the update"
  bash "$installed" orca-box-archive --all
elif [ "$changed" = 1 ] || [ "$agents" = 1 ]; then
  say "Running boxes switch to the update once they go idle (or: orca-box-update --restart)."
fi
}

# ============================================================ installer
usage_setup() {
  cat <<'USAGE'
orca.sh (installed as orca-box-setup) — set up Orca with orca-box: the Orca app itself, plus one
container per Orca workspace for Claude Code, Codex and pi. Uses Podman if it
works, otherwise Docker.

  orca.sh                    install/update Orca, install orca-box, build the
                             agent image, point Orca's agents at orca-box
  orca.sh --update           same, and rebuild the image with the latest
                             agent versions
  orca.sh --uninstall        remove orca-box (scripts, image, containers) and
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
  --orca-from FILE    install Orca from an AppImage you downloaded yourself
  --no-launch         don't start Orca to apply its settings
  --no-orca           don't change Orca's settings
  --no-build          don't build the agent image

Orca goes to ~/AppImages/orca.AppImage (ORCA_APPIMAGE_DIR to change) with an
application-menu entry. Orca must be running to change its settings; if it
isn't, the installer starts it (unless --no-launch).

Environment: PREFIX (default ~/.local) — scripts go to $PREFIX/bin.
             ORCA_BOX_ENGINE=podman|docker to override auto-detection.
USAGE
}

cmd_setup() {
PREFIX="${PREFIX:-$HOME/.local}"
BIN="$ORCA_BOX_BIN"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/orca-box"
ORCA_APP="${ORCA_APPIMAGE_DIR:-$HOME/AppImages}/orca.AppImage"
ORCA_USER_DATA="${ORCA_USER_DATA_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/orca}"

mode=install build=1 purge=0 orca=1 yolo=0 git_mode="" orca_app=1 orca_from="" launch=1
keep_boxes=0 brief=0 gh_auth=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --update)      mode=update ;;
    --uninstall)   mode=uninstall ;;
    --purge)       purge=1 ;;
    --yolo)        yolo=1 ;;
    --git=ro|--git=rw) git_mode="${1#--git=}" ;;
    --gh-auth)        gh_auth=1 ;;
    --no-orca-app) orca_app=0 ;;
    --orca-from)   orca_from="${2:?--orca-from needs a file}"; shift ;;
    --no-launch)   launch=0 ;;
    --no-orca)     orca=0 ;;
    --no-build)    build=0 ;;
    --keep-boxes)  keep_boxes=1 ;;   # --update: leave running boxes alone
    --brief)       brief=1 ;;        # short summary (used by orca-box-update)
    -h|--help)     usage_setup; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }


# Print "PID APPIMAGE" for a running Orca (APPIMAGE may be empty), or nothing.
orca_running() {
  python3 -I - "$ORCA_USER_DATA" <<'PY' 2>/dev/null || true
import json, os, sys
try:
    pid = int(json.load(open(os.path.join(sys.argv[1], "orca-runtime.json")))["pid"])
    os.kill(pid, 0)
except Exception:
    sys.exit(0)
app = ""
try:
    for entry in open(f"/proc/{pid}/environ", "rb").read().split(b"\0"):
        if entry.startswith(b"APPIMAGE="):
            app = entry[9:].decode(errors="replace")
except OSError:
    pass
print(pid, app)
PY
}

if [ "$mode" = uninstall ]; then
  if [ "$orca" = 1 ]; then
    say "Resetting Orca's Claude Code, Codex and pi commands"
    ( cmd_configure_orca --unset ) ||
      warn "couldn't reach Orca; reset the agent commands in Settings → Agents yourself"
  fi
  if ob_init 2>/dev/null; then
    say "Removing orca-box containers ($ENGINE)"
    for id in $(ob_box_ids); do echo "    $(ob_name_of "$id")"; ob rm -f "$id" >/dev/null || true; done
    say "Removing image $ORCA_BOX_IMAGE"
    ob rmi -f "$ORCA_BOX_IMAGE" >/dev/null 2>&1 || true
    if [ "$purge" = 1 ]; then
      say "Deleting saved logins (volume $ORCA_BOX_HOME_VOLUME)"
      ob volume rm -f "$ORCA_BOX_HOME_VOLUME" >/dev/null 2>&1 || true
    else
      echo "    Saved logins kept in volume '$ORCA_BOX_HOME_VOLUME' (use --uninstall --purge to delete)."
    fi
  else
    warn "no working container engine found; skipping containers, image and volume"
  fi
  if [ "$purge" = 1 ]; then
    say "Removing the Orca app and its menu entry (Orca's settings stay in $ORCA_USER_DATA)"
    ( cmd_install_orca --remove ) || warn "couldn't remove the Orca app"
  elif [ -e "$ORCA_APP" ]; then
    echo "    The Orca app stays installed at $ORCA_APP (use --uninstall --purge to remove it)."
  fi
  say "Removing scripts from $BIN and settings"
  for s in "${ORCA_BOX_TOOLS[@]}" orca-box-setup orca-box-lib.sh; do rm -f "$BIN/$s"; done
  rm -rf "$DATA" "$ORCA_BOX_CONFIG_DIR"
  ( cmd_update --disable-auto --quiet ) || true
  say "Done. If you added orca-box custom agents or an Archive Script in Orca, remove them."
  exit 0
fi

# --- checks ---------------------------------------------------------------
[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not root or sudo"
command -v git >/dev/null || die "git not found"
command -v python3 >/dev/null || die "python3 not found"
command -v curl >/dev/null || [ "$orca_app" = 0 ] || [ -n "$orca_from" ] || die "curl not found"

# --- 1. the Orca app ------------------------------------------------------
if [ "$orca_app" = 1 ]; then
  orca_args=()
  [ -n "$orca_from" ] && orca_args=(--from "$orca_from")
  ( cmd_install_orca "${orca_args[@]}" ) ||
    die "installing Orca failed (see above). Download it from https://orca.dev and rerun with --orca-from FILE, or use --no-orca-app to skip this step."
fi

# --- 2. container engine --------------------------------------------------
# Pick the engine fresh (ignore any earlier recording) unless overridden.
rm -f "$ORCA_BOX_CONFIG_DIR/engine"
ob_init || die "no usable container engine (see above)"

case "$OB_MODE" in
  podman)
    ver="$(podman version --format '{{.Client.Version}}' 2>/dev/null || echo 0)"
    major="${ver%%.*}"; rest="${ver#*.}"; minor="${rest%%.*}"
    if [ "${major:-0}" -lt 4 ] || { [ "$major" -eq 4 ] && [ "${minor:-0}" -lt 3 ]; }; then
      die "podman $ver is too old; need 4.3 or newer (or set ORCA_BOX_ENGINE=docker)"
    fi
    say "Using Podman $ver (rootless)" ;;
  docker)
    say "Using Docker"
    echo "    Note: access to the Docker daemon is root-equivalent on this machine;"
    echo "    the boxes themselves still run as your user with no capabilities." ;;
  docker-rootless)
    say "Using rootless Docker"
    echo "    Agents run as container root (your user on the host). Claude Code needs"
    echo "    IS_SANDBOX=1 to skip permissions as root; orca-box sets it." ;;
esac

# --- 3. orca-box ----------------------------------------------------------
say "Installing orca-box to $DATA/orca.sh, commands in $BIN"
mkdir -p "$BIN" "$DATA" "$ORCA_BOX_CONFIG_DIR"
# One copy of this script; every command is a link to it.
if [ -n "$ORCA_BOX_SELF" ]; then
  if [ "$ORCA_BOX_SELF" != "$(readlink -f "$DATA/orca.sh")" ]; then
    tmp="$(mktemp "$DATA/.orca.sh.XXXXXX")"
    cp "$ORCA_BOX_SELF" "$tmp"
    chmod 755 "$tmp"
    mv -f "$tmp" "$DATA/orca.sh"
  fi
else
  # Piped in (curl ... | bash): keep a copy from the same URL.
  say "Saving a copy of orca.sh from $ORCA_BOX_SOURCE_URL"
  tmp="$(mktemp "$DATA/.orca.sh.XXXXXX")"
  if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 3 -o "$tmp" "$ORCA_BOX_SOURCE_URL" ||
     ! grep -q '^# orca.sh — Orca + orca-box in one file' "$tmp" ||
     ! bash -n "$tmp"; then
    rm -f "$tmp"
    die "couldn't download a copy of orca.sh to keep. Download it (curl -fsSLO $ORCA_BOX_SOURCE_URL) and run: bash orca.sh"
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$DATA/orca.sh"
fi
rm -f "$BIN/orca-box-lib.sh"   # left over from the multi-file version
for s in "${ORCA_BOX_TOOLS[@]}" orca-box-setup; do ln -sfn "$DATA/orca.sh" "$BIN/$s"; done
ob_containerfile > "$DATA/Containerfile"
echo "$OB_MODE" > "$ORCA_BOX_CONFIG_DIR/engine"
if [ -n "$git_mode" ]; then
  ob_set_config ORCA_BOX_GIT "$git_mode"
  if [ "$git_mode" = rw ]; then
    say "Agents can stage and commit (hooks, git config and other worktrees stay read-only)"
  else
    say "Agents get a read-only .git; commit from Orca's source control tab"
  fi
fi
if [ "$gh_auth" = 1 ]; then
  ob_set_config ORCA_BOX_GH_AUTH 1
  say "Agents in the boxes can use your gh credentials (read-only; anyone in a box can read the token)"
fi

if [ "$build" = 1 ]; then
  if [ "$mode" = update ]; then
    say "Rebuilding $ORCA_BOX_IMAGE with the latest agent versions"
    ob_build "$DATA" --update
    if [ "$keep_boxes" = 0 ]; then
      say "Removing running boxes so new launches use the new image"
      ( cmd_archive --all ) || true
    else
      say "Running boxes switch to the new image once they go idle"
    fi
  else
    say "Building $ORCA_BOX_IMAGE (first build takes a few minutes)"
    ob_build "$DATA"
  fi
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn "$BIN is not on your PATH; Orca uses the full paths, so that's fine." ;;
esac

# --- 4. Orca settings -----------------------------------------------------
orca_done=0 running_from=""
if [ "$orca" = 1 ]; then
  running="$(orca_running)"
  if [ -z "$running" ] && [ "$launch" = 1 ] && [ -x "$ORCA_APP" ]; then
    say "Starting Orca to apply its settings"
    setsid -f "$ORCA_APP" </dev/null >/dev/null 2>&1 || true
    for _ in $(seq 1 90); do
      sleep 1
      running="$(orca_running)"
      [ -n "$running" ] && break
    done
    [ -n "$running" ] || warn "Orca didn't start within 90 seconds"
  fi
  if [ -n "$running" ]; then
    running_from="${running#* }"
    say "Pointing Orca's Claude Code, Codex and pi agents at orca-box"
    cfg_args=()
    [ "$yolo" = 1 ] && cfg_args+=(--yolo)
    if ( cmd_configure_orca "${cfg_args[@]}" ); then
      orca_done=1
    else
      warn "Orca's settings weren't changed (see above)."
    fi
  fi
fi

orca_app_step() {
  if [ "$orca_app" = 0 ]; then
    echo "Orca app: unchanged (--no-orca-app)."
  else
    echo "Orca app: $ORCA_APP, in your application menu as \"Orca\"."
    echo "    Orca keeps itself updated; orca-box-setup --update reinstalls the latest."
    if [ -n "$running_from" ] &&
       [ "$(readlink -f "$running_from")" != "$(readlink -f "$ORCA_APP")" ]; then
      echo "    Orca is running from $running_from right now. Quit it and start"
      echo "    Orca from the application menu to switch to the installed copy;"
      echo "    then you can delete $running_from."
    fi
  fi
}

orca_settings_step() {
  if [ "$orca_done" = 1 ]; then
    echo "Done: Orca's built-in Claude Code, Codex and pi agents now launch"
    echo "    through orca-box (see Settings → Agents → Command)."
    if [ "$yolo" = 0 ]; then
      echo "    They still ask for permissions; to stop that, set them to Yolo in"
      echo "    Settings → Agents, or rerun with --yolo."
    fi
  else
    echo "Start Orca, then run:  $BIN/orca-box-configure-orca$yolo_flag"
    echo "    (or set each agent's Command in Settings → Agents to"
    echo "    orca-box claude / codex / pi)"
  fi
  echo "    Optional: add a custom agent '$BIN/orca-box bash' for a shell in the box."
}

if [ "$brief" = 1 ]; then
  say "orca-box installed"
  return 0
fi

yolo_flag=""
[ "$yolo" = 1 ] && yolo_flag=" --yolo"
cat <<EOF

$(say "Installed.")

 1. $(orca_app_step)

 2. Sign in once (logins are shared by every box):
      $BIN/orca-box-login
    then inside: claude (/login), codex login, pi (/login), exit

 3. $(orca_settings_step)

 4. Optional, per repository in Orca: set the Archive Script to
      $BIN/orca-box-archive
    (boxes also delete themselves after 2 minutes with nothing running).

 Update later with: orca-box-update  (add --agents --orca to refresh the
 agent image and Orca too; --enable-auto to check daily)
EOF
}

# ============================================================ dispatch
main() {
  local name="${0##*/}"
  case "$name" in
    orca-box|orca-box-archive|orca-box-login|orca-box-configure-orca|orca-box-install-orca|orca-box-update|orca-box-setup) ;;
    *)  # run as orca.sh: an optional tool name first, else the installer
      case "${1:-}" in
        orca-box|orca-box-archive|orca-box-login|orca-box-configure-orca|orca-box-install-orca|orca-box-update|orca-box-setup)
          name="$1"; shift ;;
        *) name="orca-box-setup" ;;
      esac ;;
  esac
  case "$name" in
    orca-box)
      case "${1:-}" in -h|--help) usage_box; exit 0 ;; esac
      cmd_box "$@" ;;
    orca-box-archive)
      case "${1:-}" in -h|--help) usage_archive; exit 0 ;; esac
      cmd_archive "$@" ;;
    orca-box-login)
      case "${1:-}" in -h|--help) usage_login; exit 0 ;; esac
      cmd_login "$@" ;;
    orca-box-configure-orca) cmd_configure_orca "$@" ;;
    orca-box-install-orca)   cmd_install_orca "$@" ;;
    orca-box-update)         cmd_update "$@" ;;
    orca-box-setup)          cmd_setup "$@" ;;
  esac
}

# One line, so bash has read all of it before running (safe for curl | bash).
main "$@"; exit $?
