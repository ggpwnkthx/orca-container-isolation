#!/usr/bin/env bash
# install.sh — install orca-box, for this user only.
#
# Everything lands in the user's own space:
#
#   ~/.local/share/orca-box/     the program and its data
#   ~/.local/bin/                the orca-box commands
#   ~/.config/orca-box/          the settings
#   ~/AppImages/                 the Orca app
#
# Nothing is written outside $HOME, and nothing needs sudo.
#
#   curl -fsSL .../install.sh | bash
#
# If a container engine is missing, this tells you how to get one; it does
# not install it for you.
set -euo pipefail

OWNER="${ORCA_BOX_OWNER:-ggpwnkthx}"
REPO="${ORCA_BOX_REPO:-orca-box}"
RELEASE_URL="${ORCA_BOX_RELEASE_URL:-https://github.com/$OWNER/$REPO/releases/latest}"

PREFIX="${PREFIX:-$HOME/.local}"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}/orca-box"
BIN="$PREFIX/bin"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/orca-box"

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "run this as your normal user, not root or sudo"

# --- find bun ------------------------------------------------------------
# Bun is the runtime. If it isn't here, we put it in the user's own space
# (~/.bun), never in a system directory.
BUN="$HOME/.bun/bin/bun"
if ! [ -x "$BUN" ]; then
  BUN="$(command -v bun || true)"
fi

if [ -z "$BUN" ] || [ ! -x "$BUN" ]; then
  say "Installing Bun into $HOME/.bun (for your account only)"
  export BUN_INSTALL="$HOME/.bun"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 ||
    die "couldn't install Bun. Install it from https://bun.sh/install and run this again."
  BUN="$HOME/.bun/bin/bun"
  [ -x "$BUN" ] || die "Bun wasn't installed where expected; see https://bun.sh/install"
fi

say "Bun $("$BUN" --version)"

# --- find the program ----------------------------------------------------
# The release is a single self-contained executable, so nothing else has to
# be installed alongside it.
say "Fetching the latest release from $RELEASE_URL"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ASSET="orca-box-linux-x64" ;;
  aarch64|arm64) ASSET="orca-box-linux-arm64" ;;
  *) die "no orca-box build for $ARCH" ;;
esac

DOWNLOAD_URL="$RELEASE_URL/download/$ASSET"

# TLS only, unless the URL is a plain http one (which only happens when
# someone points the installer at a local mirror).
case "$DOWNLOAD_URL" in
  https://*) TLS=(--proto '=https' --tlsv1.2) ;;
  *)       TLS=() ;;
esac

if ! curl -fsSL "${TLS[@]}" --retry 3 -o "$WORK/$ASSET" "$DOWNLOAD_URL"; then
  die "couldn't download $DOWNLOAD_URL"
fi

# Check the checksum, if the release publishes one.
if curl -fsSL "${TLS[@]}" --retry 3 -o "$WORK/SHA256SUMS" \
     "$RELEASE_URL/download/SHA256SUMS" 2>/dev/null; then
  # The sums name the assets as they are attached to the release.
  grep " $ASSET\$" "$WORK/SHA256SUMS" > "$WORK/sums" 2>/dev/null || true
  if [ -s "$WORK/sums" ]; then
    ( cd "$WORK" && sha256sum -c "sums" >/dev/null ) ||
      die "the download doesn't match the published checksum; not installing"
    say "Verified SHA-256 against the published checksum"
  fi
fi

chmod 755 "$WORK/$ASSET"

# --- install -------------------------------------------------------------
say "Installing orca-box to $DATA, commands in $BIN"
mkdir -p "$DATA" "$BIN" "$CONFIG"

# Keep the old one until the new one is in place, so an interrupted install
# doesn't leave nothing behind.
if [ -f "$DATA/orca-box" ]; then
  mv -f "$DATA/orca-box" "$DATA/orca-box.old"
fi
cp "$WORK/$ASSET" "$DATA/orca-box.new"
chmod 755 "$DATA/orca-box.new"
mv -f "$DATA/orca-box.new" "$DATA/orca-box"
rm -f "$DATA/orca-box.old"

for tool in orca-box orca-box-archive orca-box-login orca-box-configure-orca \
            orca-box-install-orca orca-box-update orca-box-setup; do
  ln -sfn "$DATA/orca-box" "$BIN/$tool"
done

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn "$BIN is not on your PATH; add it to use the commands directly" ;;
esac

# --- set up --------------------------------------------------------------
# The installer does the rest: the Orca app, the agent image, Orca's
# settings. It runs as this user, into this user's space.
exec "$DATA/orca-box" orca-box-setup "$@"
