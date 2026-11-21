# ============================================================ box internals
# The helpers cmd_box is built from. They set shell variables (wt, common,
# skill_mounts, gh_mounts, ...) that cmd_box then uses.

# Which folder to give the box:
#   git repo/worktree        -> that worktree (+ .git per ORCA_BOX_GIT)
#   other folder under ~     -> that folder only (Orca folder workspaces)
#   ~ itself, a ~/.dotdir, or anywhere outside ~ -> nothing: a throwaway box
#     with no host files, enough for Orca's background checks
box_resolve_worktree() {
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
}

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
box_skill_mounts() {
  skill_mounts=() skill_sync=""
  [ "${ORCA_BOX_SKILLS:-1}" != 0 ] || return 0
  local sro d src parent entry skill real
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
}

# Your gh credentials, so agents can use the host's gh login (opt-in:
# ORCA_BOX_GH_AUTH=1). The config folder is mounted read-only: an agent
# cannot add or change credentials, but it can read the token in there, so
# this hands your GitHub token to everyone who runs in the box.
box_gh_mounts() {
  gh_mounts=() gh_env=()
  [ "${ORCA_BOX_GH_AUTH:-0}" = 1 ] || return 0
  local gh_dir v
  gh_dir="${GH_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/gh}"
  if [ -d "$gh_dir" ]; then
    gh_mounts+=(-v "$gh_dir:/home/node/.config/gh$(ob_mount_opt ro)")
  fi
  # A token in the environment instead of in gh's config folder.
  for v in GH_TOKEN GITHUB_TOKEN; do
    if [ -n "${!v:-}" ]; then gh_env+=(-e "$v"); fi
  done
}

# The .git mounts for the box, and the git environment that goes with them.
# Agents may stage and commit (ORCA_BOX_GIT=rw): objects, refs, logs and
# this worktree's own index/HEAD are writable. Read-only: everything git
# could later be made to *execute* on the host, or that belongs to other
# worktrees:
#   hooks/, config (core.hooksPath, core.fsmonitor, filter drivers,
#   aliases), info/ (attributes, grafts), refs/tags, other worktrees'
#   folders, and this worktree's config.worktree when the repo uses them.
box_git_mounts() {
  git_mounts=() git_env=()
  local rw ro p k v K gitdir
  rw="$(ob_mount_opt rw)" ro="$(ob_mount_opt ro)"
  if [ -z "$common" ]; then
    :  # not a git repo: just the folder
  elif [ "$GIT_MODE" = rw ]; then
    gitdir="$(git -C "$wt" rev-parse --path-format=absolute --git-dir)"
    git_mounts+=(-v "$common:$common$rw")
    for p in hooks config info refs/tags; do
      if [ -e "$common/$p" ]; then git_mounts+=(-v "$common/$p:$common/$p$ro"); fi
    done
    if [ -d "$common/worktrees" ]; then
      git_mounts+=(-v "$common/worktrees:$common/worktrees$ro")
      if [ "$gitdir" != "$common" ]; then
        git_mounts+=(-v "$gitdir:$gitdir$rw")
        if [ "$(git -C "$wt" config --bool extensions.worktreeConfig 2>/dev/null)" = true ]; then
          if [ ! -e "$gitdir/config.worktree" ]; then : > "$gitdir/config.worktree"; fi
          git_mounts+=(-v "$gitdir/config.worktree:$gitdir/config.worktree$ro")
        fi
      fi
    fi
    # Commit as you: your global ~/.gitconfig isn't in the box.
    for k in name email; do
      v="$(git -C "$wt" config "user.$k" 2>/dev/null || true)"
      if [ -n "$v" ]; then
        K="$(printf '%s' "$k" | tr '[:lower:]' '[:upper:]')"
        git_env+=(-e "GIT_AUTHOR_$K=$v" -e "GIT_COMMITTER_$K=$v")
      fi
    done
    # No automatic gc/maintenance: it would try to rewrite read-only parts.
    git_env+=(-e GIT_CONFIG_COUNT=2
              -e GIT_CONFIG_KEY_0=gc.auto -e GIT_CONFIG_VALUE_0=0
              -e GIT_CONFIG_KEY_1=maintenance.auto -e GIT_CONFIG_VALUE_1=false)
  else
    git_mounts+=(-v "$common:$common$ro")
  fi
}

# "true 2 <git mode>" for a running, current box; anything else needs
# (re)creating.
box_state() {
  ob inspect -f '{{.State.Running}} {{index .Config.Labels "orca.box"}} {{index .Config.Labels "orca.git"}}' \
    "$name" 2>/dev/null || true
}

# Only one launch may create the box: Orca often starts several agent
# processes for one workspace at once. Sets state and need_create.
box_lock() {
  state="$(box_state)"
  case "$state" in
    "true 2 "*) return 0 ;;  # running: just use it, no lock needed
  esac
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
  fi
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

case "${1:-}" in -h|--help) usage_box; exit 0 ;; esac
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

ob_user_args
box_resolve_worktree
box_skill_mounts
box_gh_mounts

# Options every box gets: the agent's user, no capabilities, and the shared
# home volume.
box_common=("${OB_USER_ARGS[@]}" --cap-drop=all --security-opt no-new-privileges
  "${limits[@]}" -v "$ORCA_BOX_HOME_VOLUME:/home/node" -e HOME=/home/node)

if [ -z "$wt" ]; then
  ob_prepare_home
  exec "$ENGINE" run --rm "${io[@]}" --label orca.scratch=1 \
    "${box_common[@]}" -w /home/node \
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
lock_timeout="${ORCA_BOX_LOCK_TIMEOUT:-60}"
lockfile="$lockdir/$name.lock"
need_create=0
box_lock

# The whole creation step runs with fd 9 hidden from child processes (bash
# keeps a close-on-exec copy, so we still hold the lock): nothing started
# here (podman's conmon, git's fsmonitor daemon...) may keep it.
if [ "$need_create" = 1 ]; then {
  mounts=(-v "$wt:$wt$(ob_mount_opt rw)")
  box_git_mounts
  mounts+=("${git_mounts[@]}")
  ob_prepare_home
  ob run -d --rm --name "$name" \
    --label "orca.worktree=$wt" --label orca.box=2 --label "orca.git=$GIT_MODE" \
    "${box_common[@]}" \
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
case "${1:-}" in -h|--help) usage_archive; exit 0 ;; esac
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
case "${1:-}" in -h|--help) usage_login; exit 0 ;; esac
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

