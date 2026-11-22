#!/usr/bin/env bash
# build.sh — build the orca-box program.
#
# The program is a single self-contained executable: everything it needs (the
# Containerfile, the skill-sync script) is embedded, so installing it is
# one file in the user's own space.
#
#   ./build.sh              build for this machine, into dist/
#   ./build.sh --all        build for every platform we release
#   ./build.sh --check      check that dist/ is up to date (used by CI)
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"

VERSION="$(cat VERSION)"
OUT=dist
CHECK=0
ALL=0
[ "${1:-}" = "--check" ] && CHECK=1
[ "${1:-}" = "--all" ] && ALL=1

BUN="${BUN:-$HOME/.bun/bin/bun}"
if ! [ -x "$BUN" ]; then
  BUN="$(command -v bun || true)"
fi
[ -n "$BUN" ] && [ -x "$BUN" ] || {
  echo "build.sh: bun not found. Install it from https://bun.sh/install" >&2
  exit 1
}

# The platforms we release for.
#
# The musl builds are for Alpine and other musl systems; the others are
# for glibc systems. A glibc build needs glibc 2.17 or newer, which covers
# every glibc distribution still in use.
TARGETS=(
  "bun-linux-x64:orca-box-linux-x64"
  "bun-linux-arm64:orca-box-linux-arm64"
  "bun-linux-x64-musl:orca-box-linux-x64-musl"
  "bun-linux-arm64-musl:orca-box-linux-arm64-musl"
)

mkdir -p "$OUT"

build_one() {
  local target="$1"
  local asset="$2"
  local out="$OUT/$asset"
  printf 'building %s -> %s\n' "$target" "$out"

  # Bake the version in, so the program and the release agree.
  "$BUN" build --compile \
    --target "$target" \
    --outfile "$out" \
    --define "ORCA_BOX_VERSION=\"$VERSION\"" \
    src/main.ts >/dev/null
  chmod 755 "$out"
}

if [ "$ALL" = 1 ]; then
  for entry in "${TARGETS[@]}"; do
    build_one "${entry%%:*}" "${entry##*:}"
  done
else
  # The host's own platform.
  case "$(uname -m)" in
    x86_64|amd64) build_one "bun-linux-x64" "orca-box-linux-x64" ;;
    aarch64|arm64) build_one "bun-linux-arm64" "orca-box-linux-arm64" ;;
    *) echo "build.sh: no build for $(uname -m)" >&2; exit 1 ;;
  esac
fi

# The checksums, so a download can be verified.
( cd "$OUT" && sha256sum orca-box-linux-* > SHA256SUMS 2>/dev/null ) || true

if [ "$CHECK" = 1 ]; then
  # Rebuild into a scratch copy and compare.
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  saved="$OUT"
  OUT="$scratch"
  mkdir -p "$OUT"
  for entry in "${TARGETS[@]}"; do
    build_one "${entry%%:*}" "${entry##*:}"
  done
  OUT="$saved"
  status=0
  for entry in "${TARGETS[@]}"; do
    asset="${entry##*:}"
    if ! cmp -s "$scratch/$asset" "$OUT/$asset"; then
      echo "build.sh: $OUT/$asset is out of date; run ./build.sh --all and commit the result" >&2
      status=1
    fi
  done
  [ "$status" = 0 ] && echo "build.sh: $OUT is up to date"
  exit "$status"
fi

echo "build.sh: wrote $OUT (version $VERSION)"
