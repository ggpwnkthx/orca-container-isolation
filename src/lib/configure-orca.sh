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
@@FILE:src/python/orca_client.py@@
PY
}

