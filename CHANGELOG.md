# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- A GitHub Actions workflow that builds, lints and tests every push.
- A release workflow: tag `v1.2.3` and the single-file `orca.sh` is attached
  to the GitHub Release.
- A test suite (`tests/run.sh`) that runs against a mock container engine, a
  mock curl and a mock Orca daemon, so it needs nothing installed.
- `orca-box-update` now reports versions rather than hashes.

### Changed
- **The project moved from a gist to this repository.** The single file is
  still what people download and run, but it is now generated from `src/`
  and released as a tagged version.
- `orca-box-update` fetches the latest *release* rather than the latest
  revision of a branch, so a broken `main` can never reach users.

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
