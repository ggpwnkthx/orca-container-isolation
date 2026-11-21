# ============================================================ dispatch
# The tool list is the single source of truth: the same names are linked
# into ~/.local/bin, and each one is dispatched to the command below.
ob_is_tool() {
  local t
  for t in "${ORCA_BOX_TOOLS[@]}"; do
    [ "$t" = "$1" ] && return 0
  done
  return 1
}

main() {
  local name="${0##*/}" tool=""
  if ob_is_tool "$name"; then
    tool="$name"
  elif [ "$#" -gt 0 ] && ob_is_tool "$1"; then
    tool="$1"; shift
  else
    tool="orca-box-setup"
  fi
  case "$tool" in
    orca-box)              cmd_box "$@" ;;
    orca-box-archive)      cmd_archive "$@" ;;
    orca-box-login)        cmd_login "$@" ;;
    orca-box-configure-orca) cmd_configure_orca "$@" ;;
    orca-box-install-orca) cmd_install_orca "$@" ;;
    orca-box-update)       cmd_update "$@" ;;
    orca-box-setup)        cmd_setup "$@" ;;
  esac
}

# One line, so bash has read all of it before running (safe for curl | bash).
main "$@"; exit $?
