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

# Print "PID APPIMAGE" for a running Orca (APPIMAGE may be empty), or nothing.
orca_running() {
  python3 -I - "$ORCA_USER_DATA" <<'PY' 2>/dev/null || true
@@FILE:src/python/orca_running.py@@
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
  for s in "${ORCA_BOX_TOOLS[@]}" orca-box-lib.sh; do rm -f "$BIN/$s"; done
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
  if ! ob_fetch "$ORCA_BOX_SOURCE_URL" "$tmp" || ! ob_is_orca_script "$tmp"; then
    rm -f "$tmp"
    die "couldn't download a copy of orca.sh to keep. Download it (curl -fsSLO $ORCA_BOX_SOURCE_URL) and run: bash orca.sh"
  fi
  chmod 755 "$tmp"
  mv -f "$tmp" "$DATA/orca.sh"
fi
rm -f "$BIN/orca-box-lib.sh"   # left over from the multi-file version
for s in "${ORCA_BOX_TOOLS[@]}"; do ln -sfn "$DATA/orca.sh" "$BIN/$s"; done
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

