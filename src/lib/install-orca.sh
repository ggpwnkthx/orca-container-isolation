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

version=""
if [ -n "$from" ]; then
  [ -f "$from" ] || die "no such file: $from"
  cp "$from" "$work/new.AppImage"
  say "Installing $from"
else
  say "Looking up the latest Orca release"
  ob_download "$GITHUB_API/repos/$REPO/releases/latest" "$work/release.json" 2>/dev/null ||
    die "couldn't reach GitHub's API. Download Orca from https://orca.dev and run: orca-box-install-orca --from FILE"
  # tag, AppImage URL, its sha256 (may be empty), latest-linux.yml URL (may be empty)
  mapfile -t info < <(python3 -I - "$work/release.json" "$asset" "$yml" <<'PY'
@@FILE:src/python/release_info.py@@
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
    ob_download "$url" "$work/new.AppImage"
    if [ -n "$sha256" ]; then
      [ "$(sha256sum "$work/new.AppImage" | cut -d' ' -f1)" = "$sha256" ] ||
        die "SHA-256 of the download doesn't match GitHub's digest; not installing"
      say "Verified SHA-256 against GitHub's digest"
    elif [ -n "$yml_url" ] && ob_download "$yml_url" "$work/latest.yml" 2>/dev/null; then
      python3 -I - "$work/latest.yml" "$asset" "$work/new.AppImage" <<'PY' ||
@@FILE:src/python/verify_appimage.py@@
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
@@FILE:src/python/desktop_entry.py@@
PY
chmod 644 "$DESKTOP_FILE"
if command -v desktop-file-validate >/dev/null; then
  desktop-file-validate "$DESKTOP_FILE" 2>&1 | sed 's/^/    /' >&2 || true
fi
refresh_menus
say "Menu entry: $DESKTOP_FILE"
}

