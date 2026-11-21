#!/usr/bin/env bash
# build.sh — assemble the single-file orca.sh from src/.
#
# The repository is the source of truth; orca.sh at the root is what people
# download and run. This script regenerates it, so the two cannot drift.
#
#   ./build.sh          rebuild orca.sh
#   ./build.sh --check  fail if orca.sh is out of date (used by CI)
#
# The Python helpers, the Containerfile and the skill-sync script live in
# src/ as separate files. Each is referenced from the shell by an
# @@FILE:path@@ marker, which this script expands back into the file's
# contents: the result is one self-contained file that can still be piped
# to bash.
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
ROOT="$PWD"

OUT=orca.sh
CHECK=0
[ "${1:-}" = --check ] && CHECK=1

# The order the modules are concatenated in.
MODULES=(common box configure-orca install-orca update setup)

die() { printf 'build.sh: %s\n' "$*" >&2; exit 1; }

# --- expand the @@FILE:...@@ markers -------------------------------------
expand() {
  local src="$1" dst="$2"

  # A marker is a whole line: "@@FILE:<path>@@". Replace it with the
  # file's contents (heredocs keep their own indentation, and the python
  # files are used verbatim). "@@VERSION@@" is replaced with the version
  # from the VERSION file.
  python3 - "$src" "$dst" "$ROOT/VERSION" <<'PY'
import os, re, sys

src, dst, version_file = sys.argv[1], sys.argv[2], sys.argv[3]
marker = re.compile(r'^@@FILE:(.+?)@@$', re.M)

with open(version_file, encoding='utf-8') as f:
    version = f.read().strip()


def expand(m):
    path = m.group(1)
    with open(path, encoding='utf-8') as f:
        return f.read().rstrip('\n')


with open(src, encoding='utf-8') as f:
    text = f.read()

missing = sorted({m for m in marker.findall(text) if not os.path.exists(m)})
if missing:
    sys.exit('build.sh: missing asset(s): %s' % ', '.join(missing))

text = marker.sub(expand, text)
text = text.replace('@@VERSION@@', version)

with open(dst, 'w', encoding='utf-8') as f:
    f.write(text)
PY
}

# --- build ----------------------------------------------------------------
build() {
  local tmp
  tmp="$(mktemp)"

  cat src/header.sh  >  "$tmp"
  cat src/globals.sh >> "$tmp"
  local m
  for m in "${MODULES[@]}"; do
    cat "src/lib/$m.sh" >> "$tmp"
  done
  cat src/dispatch.sh >> "$tmp"

  expand "$tmp" "$OUT"
  chmod 755 "$OUT"
  rm -f "$tmp"
}

if [ "$CHECK" = 1 ]; then
  # Rebuild into a scratch copy and compare, leaving orca.sh untouched.
  scratch="$(mktemp)"
  cp "$OUT" "$scratch"
  build
  if ! cmp -s "$scratch" "$OUT"; then
    echo "build.sh: $OUT is out of date; run ./build.sh and commit the result" >&2
    rm -f "$scratch"
    exit 1
  fi
  rm -f "$scratch"
  echo "build.sh: $OUT is up to date"
else
  build
  echo "build.sh: wrote $OUT ($(wc -l < "$OUT") lines)"
fi
