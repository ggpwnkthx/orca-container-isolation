# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [1.7.4]

### Fixed
- On Windows the program found no programs at all: the programs
  there have a .exe extension, and only the name without it was looked
  for. The container engine was never found there.

### Changed
- The tests run on every platform now: they no longer expect the
  Linux paths, and the parts that need a shell or a unix socket are
  skipped where there is none.

## [1.7.3]

### Fixed
- Asking the program for help no longer sets it up first: a copy
  that has not been set up yet prints its usage and stops, instead of
  building the agent image and installing the app first.

## [1.7.2]

### Changed
- The README and CONTRIBUTING describe macOS, Windows and the
  program that installs itself.

## [1.7.1]

### Added
- Tests for the command resolution, the platform helpers, the macOS
  and Windows paths, and a mock container engine that is a program, so
  the tests run on Windows too.

## [1.7.0]

### Added
- The release carries an executable for every platform: Linux (x64
  and arm64, glibc and musl), macOS (Apple silicon and Intel) and
  Windows.

### Fixed
- `build.sh` no longer needs `readlink -f` and `sha256sum`, which
  macOS doesn't have.

## [1.6.1]

### Fixed
- The worktree is found with older versions of git too (before 2.31,
  which introduced `--path-format`).
- The program no longer shells out to `rm`, `mv` and `cp`, which
  Windows doesn't have.
- The login box falls back to the ordinary network when the engine
  has no host network (Docker Desktop on macOS, unless it is turned on).

## [1.6.0]

### Added
- **macOS support.** The program now runs on macOS as well as on
  Linux:
  - the Orca app is installed from the release's disk image: the
    image is mounted and `Orca.app` is copied to `~/Applications`
    (`ORCA_APP_DIR`)
  - the daily update is a launchd agent (`~/Library/LaunchAgents`)
    instead of a systemd timer
  - the per-workspace lock uses `lockf` (macOS) as well as `flock`
    (Linux), and falls back to a lock file of its own when neither is
    there
  - the name a command was called by is read from `ps`, since macOS
    has no `/proc`
  - `~/.local/bin` is not on the PATH by default on macOS, so the
    setup says how to add it

## [1.5.0]

### Added
- **Windows support.** The program now runs on Windows as well as on
  Linux and macOS:
  - a Windows drive becomes a folder inside the box, so the worktree
    at `C:\Users\me\project` is mounted at `/c/Users/me/project`
  - the commands are small `.cmd` files, because Windows cannot run
    a program through a link; a command can also be named as the first
    argument, which is how Orca starts them
  - the Orca app is installed from the release's installer, which is
    downloaded, checked and then run
  - the daily update is a task in the Task Scheduler
  - git is told to trust the worktree, because the files Docker
    Desktop shares with its virtual machine belong to root in the container

## [1.4.0]

### Changed
- **The program is installed by downloading it.** The release carries
  one executable per platform, and people download the one for their
  machine and run it: it copies itself into place, builds the agent
  image, installs the Orca app and points Orca's agents at orca-box.
  There is no bootstrapper script any more, so nothing needs Bun or
  curl on the machine that runs it.

### Fixed
- **The program had two entry behaviours, decided by the name it was
  called by.** A downloaded copy set itself up; a copy renamed to
  `orca-box` did not, and said something confusing instead. The two
  questions are now answered separately: the name says which command to
  run, and whether the file is the installed program says whether it has
  to be set up first. A copy that has not been set up now sets itself up
  and then does what was asked.

## [1.3.2]

### Added
- `ORCA_BOX_NO_NEW_PRIVILEGES` turns the `no-new-privileges`
  security option off, for engines that don't know it (some Docker
  Desktop versions on macOS). The setup works out whether the engine
  accepts it.

## [1.3.1]

### Changed
- The settings and Orca's own data are found where the platform
  keeps them: the XDG folders, ~/Library/Application Support or
  %APPDATA%.

## [1.3.0]

### Added
- The Orca app is installed the way the platform does it: an
  AppImage on Linux, an application bundle from the release's disk
  image on macOS, and the release's installer on Windows.

## [1.2.1]

### Fixed
- The self-update now checks the download against the checksum the
  release publishes, and refuses an update that doesn't match.

## [1.2.0]

### Added
- The self-update fetches the release asset for the machine it runs
  on, instead of the Linux one.
- The daily update is a launchd agent on macOS and a task in the
  Task Scheduler on Windows, instead of a systemd timer.

## [1.1.1]

### Fixed
- The program now knows which command it was started as on every
  platform: the name in the environment (Windows), the first word of
  the command line (Linux and macOS) or the program itself.

## [1.1.0]

### Added
- A GitHub Actions workflow that typechecks, tests and builds every push.
- A release workflow: tag `v1.2.3` and the executables are attached to the
  GitHub Release, with their checksums.
- A test suite (`bun test`) that runs against a mock container engine and a
  mock Orca daemon, so it needs nothing installed.
- `orca-box-update` now reports versions rather than hashes.

### Fixed
- The agent image builds on arm64: the GitHub CLI was pinned to the amd64
  build, so `gh` in the box was the wrong architecture. It now comes from
  the official apt repository the GitHub CLI maintainers publish, which has
  a package per architecture: apt picks the right one, so there is no
  architecture to detect and no per-architecture checksum to maintain.
- `fd` is linked in the box. Debian installs it as `fdfind`, and the agents
  ask for `fd`.
- `orca-box-update --disable-auto` no longer fails on a system without
  systemd.
- Finding a program no longer shells out to `which`, which isn't installed
  on every system, and a missing program no longer crashes the program.
- The installer no longer asks for `python3`; nothing needs it any more.
- On a system without FUSE, Orca is extracted instead of mounted, so the
  menu entry works.

### Changed
- **The project moved from a gist to this repository.**
- **The implementation is now TypeScript, running on Bun.** The bash
  sources and the Python helpers are gone; the program is built from `src/`
  into a single self-contained executable.
- **Everything installs into the user's own space.** The bootstrapper puts
  Bun in `~/.bun` if it isn't there, and the program, the commands, the
  settings and the Orca app all go under the user's home directory.
  Nothing needs `sudo`.
- `orca-box-update` fetches the latest *release* rather than the latest
  revision of a branch, so a broken `main` can never reach users.
- musl builds (Alpine) are released alongside the glibc ones, and the
  installer picks the right one.
- Internal: the platform, the paths, the commands and the release
  information moved into modules of their own, so the rest of the program
  asks one place where it is running.

## [1.0.0]

The last release made as a gist.

- One container per Orca workspace, for Claude Code, Codex and pi.
- Read-only `.git` by default; `ORCA_BOX_GIT=rw` lets agents stage and
  commit while keeping hooks and git config read-only.
- The host's skills are mounted into the box read-only, and appear in it
  live: a skill installed while a box runs shows up without a restart.
- The Orca app is installed and updated, with an application-menu entry.
- `orca-box-login` signs in to the agents once, for every box.
- `orca-box-update` self-updates, and can refresh the agent image and the
  Orca app at the same time.
