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

# --- output -------------------------------------------------------------
# say/warn/die are shared by every command. ob_quiet silences say(); it is
# set by orca-box-update --quiet only.
ob_quiet=0
say()  { [ "$ob_quiet" = 1 ] || printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- downloads ----------------------------------------------------------
# TLS only, with retries and a connect timeout, for every fetch.
CURL_FLAGS=(--proto '=https' --tlsv1.2 --retry 3 --connect-timeout 20)

# Download URL to FILE, quietly.
ob_fetch() { curl -fsSL "${CURL_FLAGS[@]}" -o "$2" "$1"; }

# Download URL to FILE, showing progress (for the big files).
ob_download() { curl -fL "${CURL_FLAGS[@]}" -H 'User-Agent: orca-box-installer' -o "$2" "$1"; }

# True if FILE is a valid orca.sh: used before trusting any download.
ob_is_orca_script() { grep -q '^# orca.sh — Orca + orca-box in one file' "$1" && bash -n "$1"; }

# True if the Docker daemon is running rootless.
ob_docker_rootless() { docker info --format '{{json .SecurityOptions}}' 2>/dev/null | grep -q rootless; }

# Print the engine mode: podman, docker or docker-rootless.
ob_detect_mode() {
  if command -v podman >/dev/null 2>&1 && podman info >/dev/null 2>&1; then
    echo podman
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    if ob_docker_rootless; then
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
             if ob_docker_rootless; then OB_MODE=docker-rootless; fi ;;
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
@@FILE:src/container/Containerfile@@
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
@@FILE:src/container/skill-sync.sh@@
EOF
}

