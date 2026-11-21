set -euo pipefail

# Where this script came from. Piped in (curl ... | bash) there is no file, so
# the installer fetches the copy it keeps from ORCA_BOX_SOURCE_URL instead.
#
# That is the latest release, not the main branch: a tagged release is what
# users get, so a broken main can never reach them.
ORCA_BOX_SOURCE_URL="${ORCA_BOX_SOURCE_URL:-https://github.com/ggpwnkthx/orca-box/releases/latest/download/orca.sh}"
# The version of this script. build.sh stamps it in from the VERSION file.
# Read out of the file by orca-box-update, not from this variable.
# shellcheck disable=SC2034
ORCA_BOX_VERSION="@@VERSION@@"
ORCA_BOX_SELF=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  ORCA_BOX_SELF="$(readlink -f "${BASH_SOURCE[0]}")"
fi
ORCA_BOX_BIN="${PREFIX:-$HOME/.local}/bin"
ORCA_BOX_TOOLS=(orca-box orca-box-archive orca-box-login orca-box-configure-orca orca-box-install-orca orca-box-update orca-box-setup)
