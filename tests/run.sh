#!/usr/bin/env bash
# tests/run.sh — the test suite for orca-box.
#
# Everything runs against mocks: a fake container engine, a fake curl and a
# fake Orca daemon. Nothing here needs Podman, Docker or Orca installed.
#
#   tests/run.sh            run everything
#   tests/run.sh --verbose  show the engine log of any failing case
#
# The cases assert on what the script asks the container engine to do, and
# on what it prints, rather than on the exact command line: the point is the
# behaviour (which paths are mounted read-write, which read-only), not the
# order the arguments happen to be in.
set -uo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/.." || exit 1

VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

ROOT="$PWD"
SCRIPT="$ROOT/orca.sh"
MOCKS="$ROOT/tests/mocks"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
failed_names=()

# --- helpers --------------------------------------------------------------

setup_env() {
  rm -rf "${WORK:?}/home" "${WORK:?}/repo"
  mkdir -p "$WORK/home/.agents/skills/demo" "$WORK/home/.claude/skills" \
           "$WORK/home/.config/gh"
  echo "skill" > "$WORK/home/.agents/skills/demo/SKILL.md"
  git -C "$WORK" init -q repo
  git -C "$WORK/repo" config user.name Tester
  git -C "$WORK/repo" config user.email t@example.com
  git -C "$WORK/repo" commit -q --allow-empty -m init
}

# Run the script with the mocks on PATH, capturing the engine's log.
# Usage: run <args...>
run() {
  : > "$WORK/engine.log"
  ( cd "${WORKDIR:-$WORK}" && \
    env HOME="$WORK/home" \
        PATH="$MOCKS:$PATH" \
        FAKE_LOG="$WORK/engine.log" \
        FAKE_EXISTING="${FAKE_EXISTING:-1}" \
        FAKE_FIXTURES="${FAKE_FIXTURES:-$WORK/fixtures}" \
        FAKE_GIT="${FAKE_GIT:-ro}" \
        ${EXTRA_ENV:+env $EXTRA_ENV} \
        bash "$SCRIPT" "$@" ) > "$WORK/out.txt" 2>&1
}

# assert_log <name> <description> <grep-pattern>...
# The pattern is matched against the engine log with grep -F.
assert_log() {
  local name="$1" desc="$2"; shift 2
  local p
  for p in "$@"; do
    if ! grep -qF -- "$p" "$WORK/engine.log"; then
      fail=$((fail + 1)); failed_names+=("$name")
      printf '  FAIL %s\n' "$name"
      printf '       missing: %s\n' "$p"
      [ "$VERBOSE" = 1 ] && sed 's/^/       | /' "$WORK/engine.log"
      return
    fi
  done
  pass=$((pass + 1)); printf '  ok   %s\n' "$desc"
}

# assert_out <name> <description> <grep-pattern>...
assert_out() {
  local name="$1" desc="$2"; shift 2
  local p
  for p in "$@"; do
    if ! grep -qF -- "$p" "$WORK/out.txt"; then
      fail=$((fail + 1)); failed_names+=("$name")
      printf '  FAIL %s\n' "$name"
      printf '       missing: %s\n' "$p"
      [ "$VERBOSE" = 1 ] && sed 's/^/       | /' "$WORK/out.txt"
      return
    fi
  done
  pass=$((pass + 1)); printf '  ok   %s\n' "$desc"
}

# assert_no_log <name> <description> <grep-pattern>...
assert_no_log() {
  local name="$1" desc="$2"; shift 2
  local p
  for p in "$@"; do
    if grep -qF -- "$p" "$WORK/engine.log"; then
      fail=$((fail + 1)); failed_names+=("$name")
      printf '  FAIL %s\n' "$name"
      printf '       unexpectedly present: %s\n' "$p"
      [ "$VERBOSE" = 1 ] && sed 's/^/       | /' "$WORK/engine.log"
      return
    fi
  done
  pass=$((pass + 1)); printf '  ok   %s\n' "$desc"
}

# --- the cases ------------------------------------------------------------

echo "orca-box test suite"

# 1. A box in a git repo, with the .git directory read-only.
setup_env
WORKDIR="$WORK/repo"
run orca-box claude
assert_log "box-ro" "box: runs the agent in the workspace's box" \
  "PODMAN exec -i -w $WORK/repo" "orca-repo-"
assert_no_log "box-ro" "box: an existing box is reused, not recreated" \
  "PODMAN run -d --rm --name"

# 2. Outside a repo, the box gets no host files at all.
setup_env
WORKDIR="$WORK"
run orca-box claude
assert_log "box-scratch" "box: outside a repo, a throwaway box with no host files" \
  "--label orca.scratch=1"
assert_no_log "box-scratch" "box: outside a repo, nothing of the host is mounted" \
  "$WORK/repo"

# 3. Creating a box in a git repo: .git is read-only by default.
setup_env
export FAKE_EXISTING=0
WORKDIR="$WORK/repo"
run orca-box claude
assert_log "box-create-ro" "box: creation mounts the worktree read-write" \
  "-v $WORK/repo:$WORK/repo"
assert_log "box-create-ro" "box: creation mounts .git read-only by default" \
  "-v $WORK/repo/.git:$WORK/repo/.git:ro"
unset FAKE_EXISTING

# 4. With ORCA_BOX_GIT=rw, .git becomes writable but hooks and config stay
#    read-only: they are what git could later be made to *execute*.
setup_env
export FAKE_EXISTING=0
export EXTRA_ENV="ORCA_BOX_GIT=rw"
WORKDIR="$WORK/repo"
run orca-box claude
assert_log "box-rw" "box: rw mode makes .git writable" \
  "-v $WORK/repo/.git:$WORK/repo/.git"
assert_log "box-rw" "box: rw mode keeps hooks read-only" \
  "-v $WORK/repo/.git/hooks:$WORK/repo/.git/hooks:ro"
assert_log "box-rw" "box: rw mode keeps git config read-only" \
  "-v $WORK/repo/.git/config:$WORK/repo/.git/config:ro"
assert_log "box-rw" "box: rw mode keeps refs/tags read-only" \
  "-v $WORK/repo/.git/refs/tags:$WORK/repo/.git/refs/tags:ro"
assert_log "box-rw" "box: rw mode tells git not to run maintenance" \
  "GIT_CONFIG_KEY_1=maintenance.auto"
unset FAKE_EXISTING EXTRA_ENV

# 5. A linked worktree: the other worktrees' folders stay read-only.
setup_env
export FAKE_EXISTING=0
export EXTRA_ENV="ORCA_BOX_GIT=rw"
git -C "$WORK/repo" worktree add -f "$WORK/wt" -q
WORKDIR="$WORK/wt"
run orca-box claude
assert_log "box-worktree" "box: a linked worktree gets its own box" \
  "-v $WORK/wt:$WORK/wt"
assert_log "box-worktree" "box: other worktrees' folders stay read-only" \
  "-v $WORK/repo/.git/worktrees:$WORK/repo/.git/worktrees:ro"
unset FAKE_EXISTING EXTRA_ENV

# 6. gh credentials are only mounted when asked for.
setup_env
export FAKE_EXISTING=0
WORKDIR="$WORK/repo"
run orca-box claude
assert_no_log "gh-off" "box: gh credentials are not mounted by default" \
  "/home/node/.config/gh"
unset FAKE_EXISTING

setup_env
export FAKE_EXISTING=0
export EXTRA_ENV="ORCA_BOX_GH_AUTH=1"
WORKDIR="$WORK/repo"
run orca-box claude
assert_log "gh-on" "box: gh credentials are mounted read-only when enabled" \
  "-v $WORK/home/.config/gh:/home/node/.config/gh:ro"
unset FAKE_EXISTING EXTRA_ENV

# 7. The host's skills are mounted read-only, so an agent cannot plant code
#    in a skill every other box would then run.
setup_env
export FAKE_EXISTING=0
WORKDIR="$WORK/repo"
run orca-box claude
assert_log "skills" "box: the host's skills are mounted read-only" \
  "-v $WORK/home/.agents/skills:$WORK/home/.agents/skills:ro"
unset FAKE_EXISTING

setup_env
export FAKE_EXISTING=0
export EXTRA_ENV="ORCA_BOX_SKILLS=0"
WORKDIR="$WORK/repo"
run orca-box claude
assert_no_log "skills-off" "box: ORCA_BOX_SKILLS=0 turns the skill mounts off" \
  ".agents/skills"
unset FAKE_EXISTING EXTRA_ENV

# 8. The container gets no capabilities and no privilege escalation.
setup_env
export FAKE_EXISTING=0
WORKDIR="$WORK/repo"
run orca-box claude
assert_log "hardening" "box: the container drops all capabilities" \
  "--cap-drop=all --security-opt no-new-privileges"
unset FAKE_EXISTING

# 9. --help works for every command, and says something.
for cmd in orca-box orca-box-archive orca-box-login orca-box-configure-orca \
           orca-box-install-orca orca-box-update orca-box-setup; do
  setup_env
  run "$cmd" --help
  assert_out "help-$cmd" "help: $cmd --help prints its usage" "$cmd"
done

# 10. An unknown option is rejected with a usage error.
setup_env
run orca-box-update --nope
assert_out "bad-opt" "an unknown option is rejected" "unknown option"

# 11. The installer links every command and installs the script.
setup_env
run orca-box-setup --no-orca-app --no-build --no-orca --no-launch
missing=""
for s in orca-box orca-box-archive orca-box-login orca-box-configure-orca \
         orca-box-install-orca orca-box-update orca-box-setup; do
  [ -L "$WORK/home/.local/bin/$s" ] || missing="$missing $s"
done
if [ -z "$missing" ] && [ -f "$WORK/home/.local/share/orca-box/orca.sh" ]; then
  pass=$((pass + 1)); echo "  ok   setup: links every command"
else
  fail=$((fail + 1)); failed_names+=("setup links"); echo "  FAIL setup: links every command (missing:$missing)"
fi

# 12. The uninstaller removes them again.
run orca-box-setup --uninstall --no-orca
left=""
for s in orca-box orca-box-archive orca-box-update; do
  [ -e "$WORK/home/.local/bin/$s" ] && left="$left $s"
done
if [ -z "$left" ] && [ ! -d "$WORK/home/.local/share/orca-box" ]; then
  pass=$((pass + 1)); echo "  ok   uninstall: removes the commands"
else
  fail=$((fail + 1)); failed_names+=("uninstall"); echo "  FAIL uninstall: removes the commands (left:$left)"
fi

# 13. A corrupt config value is rejected.
setup_env
mkdir -p "$WORK/home/.config/orca-box"
echo "ORCA_BOX_GIT=maybe" > "$WORK/home/.config/orca-box/config"
run orca-box claude
assert_out "bad-config" "config: an invalid ORCA_BOX_GIT is rejected" \
  "ORCA_BOX_GIT must be ro or rw"

# 14. A valid config value is honoured.
setup_env
mkdir -p "$WORK/home/.config/orca-box"
echo "ORCA_BOX_GIT=rw" > "$WORK/home/.config/orca-box/config"
export FAKE_EXISTING=0
WORKDIR="$WORK/repo"
run orca-box claude
assert_log "config-rw" "config: ORCA_BOX_GIT=rw from the config file is honoured" \
  "-v $WORK/repo/.git:$WORK/repo/.git"
unset FAKE_EXISTING

# 15. The built file is a valid bash script and passes shellcheck.
if bash -n "$SCRIPT" 2>/dev/null; then
  pass=$((pass + 1)); echo "  ok   build: orca.sh parses"
else
  fail=$((fail + 1)); failed_names+=("bash -n"); echo "  FAIL build: orca.sh parses"
fi

if command -v shellcheck >/dev/null; then
  if shellcheck -S warning "$SCRIPT" > "$WORK/sc.txt" 2>&1; then
    pass=$((pass + 1)); echo "  ok   build: orca.sh passes shellcheck"
  else
    fail=$((fail + 1)); failed_names+=("shellcheck"); echo "  FAIL build: orca.sh passes shellcheck"
    [ "$VERBOSE" = 1 ] && sed 's/^/       /' "$WORK/sc.txt"
  fi
fi

# 16. The built file is up to date with src/.
if "$ROOT/build.sh" --check > "$WORK/bc.txt" 2>&1; then
  pass=$((pass + 1)); echo "  ok   build: orca.sh is up to date with src/"
else
  fail=$((fail + 1)); failed_names+=("build --check"); echo "  FAIL build: orca.sh is up to date with src/"
  [ "$VERBOSE" = 1 ] && sed 's/^/       /' "$WORK/bc.txt"
fi

# 17. The python helpers are valid python.
pybad=""
for f in "$ROOT"/src/python/*.py; do
  python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$f" 2>/dev/null \
    || pybad="$pybad $f"
done
if [ -z "$pybad" ]; then
  pass=$((pass + 1)); echo "  ok   build: the python helpers parse"
else
  fail=$((fail + 1)); failed_names+=("python parse"); echo "  FAIL build: the python helpers parse ($pybad)"
fi

# 18. Talking to Orca: the agents are pointed at orca-box, and back again.
setup_env
mkdir -p "$WORK/orca-data" "$WORK/orca-sock"
chmod 700 "$WORK/orca-sock"
python3 "$MOCKS/orca-daemon.py" "$WORK/orca-data" "$WORK/orca-sock/orca.sock" \
  > "$WORK/orca.log" 2>&1 &
daemon_pid=$!
# Wait for the daemon to bind its socket.
for _ in $(seq 1 50); do
  [ -S "$WORK/orca-sock/orca.sock" ] && break
  sleep 0.1
done

export EXTRA_ENV="ORCA_USER_DATA_PATH=$WORK/orca-data"
run orca-box-configure-orca
assert_out "orca-set" "orca: the agents are pointed at orca-box" \
  "claude  command: (default) -> orca-box claude" \
  "codex   command: codex --yolo -> orca-box codex" \
  "pi      command: (default) -> orca-box pi"

# The commands that were there before are remembered, so --unset can put
# them back.
run orca-box-configure-orca --unset
assert_out "orca-unset" "orca: --unset restores the previous commands" \
  "codex   command: orca-box codex -> codex --yolo"

# With Orca not running, the tool says so and exits 3.
kill "$daemon_pid" 2>/dev/null
wait "$daemon_pid" 2>/dev/null
rm -f "$WORK/orca-data/orca-runtime.json"
run orca-box-configure-orca
assert_out "orca-not-running" "orca: a missing Orca is reported clearly" \
  "Orca isn't running"
unset EXTRA_ENV

# 19. The self-update finds a newer release and reports the version.
setup_env
run orca-box-setup --no-orca-app --no-build --no-orca --no-launch
mkdir -p "$WORK/fixtures"
# A "newer release": the same script with a bumped version.
sed 's/^ORCA_BOX_VERSION=.*/ORCA_BOX_VERSION="9.9.9"/' "$SCRIPT" > "$WORK/fixtures/orca.sh"
export EXTRA_ENV="ORCA_BOX_SOURCE_URL=https://mock/orca.sh"
run orca-box-update --check
assert_out "update-check" "update: a newer release is reported with its version" \
  "Update available: 1.0.0 -> 9.9.9"

# The same release as the one installed: nothing to do.
cp "$SCRIPT" "$WORK/fixtures/orca.sh"
run orca-box-update --check
assert_out "update-uptodate" "update: the current version is reported as up to date" \
  "orca-box is up to date (1.0.0)"

# A download that is not an orca.sh is refused.
echo "not an orca.sh" > "$WORK/fixtures/orca.sh"
run orca-box-update --check
assert_out "update-invalid" "update: a download that is not an orca.sh is refused" \
  "isn't a valid orca.sh"
unset EXTRA_ENV

# --- summary --------------------------------------------------------------
echo
echo "passed: $pass  failed: $fail"
if [ "$fail" -gt 0 ]; then
  printf 'failing: %s\n' "${failed_names[*]}"
  exit 1
fi
