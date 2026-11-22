# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/).

## [Unreleased]

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
