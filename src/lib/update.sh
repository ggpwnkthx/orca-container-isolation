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
local ob_quiet=0   # --quiet silences say() for this command only
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) check=1 ;;
    --agents) agents=1 ;;
    --orca) orca=1 ;;
    --restart) restart=1 ;;
    --quiet) quiet=1; ob_quiet=1 ;;
    --enable-auto) auto=on ;;
    --disable-auto) auto=off ;;
    -h|--help) usage_update; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

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
ob_fetch "$ORCA_BOX_SOURCE_URL" "$tmp" || die "couldn't download $ORCA_BOX_SOURCE_URL"
if ! ob_is_orca_script "$tmp"; then
  die "the download isn't a valid orca.sh; not updating"
fi

local old="(not installed)" new changed=1
# The version the download carries, and the one we are running.
new="$(grep -m1 '^ORCA_BOX_VERSION=' "$tmp" | cut -d'"' -f2)"
[ -n "$new" ] || new="(unknown version)"
if [ -f "$installed" ]; then
  old="$(grep -m1 '^ORCA_BOX_VERSION=' "$installed" | cut -d'"' -f2)"
  [ -n "$old" ] || old="(unknown version)"
  cmp -s "$tmp" "$installed" && changed=0
fi

if [ "$check" = 1 ]; then
  if [ "$changed" = 1 ]; then
    echo "Update available: $old -> $new. Run: orca-box-update"
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

