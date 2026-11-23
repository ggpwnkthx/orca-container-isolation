#!/bin/sh
# Chromium, in a box.
#
# The boxes drop every capability, so Chromium's own sandbox cannot
# start: it wants either a setuid helper or user namespaces that the
# container does not have. The container is the sandbox here, so the
# browser runs without one of its own.
#
# The profile is a temporary folder of this run's own: the boxes share
# one home folder, and two browsers with one profile refuse to start.
#
# This wrapper is what the browser tools find: it is named chromium, so
# it comes first on the PATH, and the browser variables (IMPECCABLE_BROWSER,
# CHROME_PATH, PUPPETEER_EXECUTABLE_PATH) point at it too.
set -eu

if [ ! -x /usr/bin/chromium ]; then
  echo "chromium: this image was built without a browser" >&2
  exit 127
fi

# A headless run is asked for by the caller; without one, and without a
# display to show a window on, the browser takes screenshots instead.
headless=0
for arg in "$@"; do
  case "$arg" in
    --headless*) headless=1 ;;
  esac
done

profile="$(mktemp -d)"
child=""
cleanup() {
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null || true
  fi
  rm -rf "$profile"
}
trap cleanup INT TERM HUP

# The flags come first, so a caller that wants one of them can still
# have it: the last one wins.
set -- --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage \
  "--user-data-dir=$profile" "$@"

if [ "$headless" -eq 0 ] && [ -z "${DISPLAY:-}" ]; then
  set -- --headless=new "$@"
fi

/usr/bin/chromium "$@" &
child=$!
status=0
wait "$child" || status=$?
rm -rf "$profile"
exit "$status"
