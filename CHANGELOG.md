# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- The agent image has a browser in it, so the skills that look at a page
  work: Chromium from Debian (with the shared libraries it needs -- a
  browser that was put into an image by hand cannot start, because half
  of it is missing), Playwright in Node and in Python with the browser
  it drives, and the fonts a page needs to be readable. The Playwright
  browsers are found in the home folder, so one an agent installs
  survives the box.
- The browser is started through a wrapper that turns Chromium's own
  sandbox off (the boxes drop every capability, so it cannot start; the
  container is the sandbox here) and gives every run a profile of its
  own (the boxes share one home folder, and two browsers with one
  profile refuse to start). The browser tools find it: it is named
  chromium, so it comes first on the PATH, and IMPECCABLE_BROWSER,
  CHROME_PATH and PUPPETEER_EXECUTABLE_PATH point at it.
- ~/.local/bin is on the PATH in a box, so a program the user installed
  once is found in every box.
- TMPDIR in a box points at a scratch folder of that box's own, in the
  home folder: the temporary files tools make survive the box, which
  /tmp does not.
- A box leaves a note in ~/.orca-box.md saying what survives and what
  does not, for the agents that work in it.
- ORCA_BOX_SHM_SIZE (1g): the shared memory a box gets. The default 64MB
  the engines give is too little for a browser.
- ORCA_BOX_BROWSER (1): set it to 0 to build the image without the
  browser and Playwright, for the images that do not want them.

### Fixed
- The browser in a box survives the box being thrown away and made
  again. A box is thrown away when nothing has been running in it for a
  couple of minutes, and the next launch makes a new one -- with an
  empty /tmp, and without anything the agent had put there. The home
  folder is a volume, so it survives; that is where the tools that have
  to outlive a box belong.

## [1.7.19]

### Fixed
- The host's GitHub credentials are found even when gh is not on the
  PATH. The token was only ever asked of the host's `gh`, and gh was
  only looked for on the PATH -- but the program is usually started by
  Orca, a desktop app whose PATH is a short one, and gh is then in
  /opt/homebrew/bin where Orca cannot see it. So the token was never
  found, nothing was passed to the boxes, and the agent's gh was not
  logged in. Updating and making new boxes could not help, because the
  token was never there to be passed on.
- The token is looked for where gh looks for it: in the environment, in
  the gh settings file (where gh writes it in plain text when there is
  no credential store), and in the credential store -- which the host's
  gh is asked for, and which the macOS keychain is asked about when
  there is no gh to ask.
- The host's gh is found where it is installed, not only on the PATH:
  Homebrew's folders, ~/.local/bin, the Windows install folders, and
  GH_PATH, which is the variable gh itself uses to say where it is.
- The gh host is passed with the token, so that gh in the box asks the
  host the host's gh was asked about.
- A box says when no GitHub token could be found on the host, and what
  to do about it, rather than leaving the agent with an unauthenticated
  gh to wonder about.

## [1.7.18]

### Fixed
- The gh token reaches the containers. The token was put in the
  program's own environment and passed to the engine by name (`-e
  GH_TOKEN`), but the engine takes the value of a variable it is given
  by name from the environment *it* is started with -- and a variable set
  in the program's environment is not in that one. So the containers got
  no token at all: the settings folder was mounted, but the token, which
  on macOS and Windows is in no file to mount, never arrived, and the
  agent's gh was not logged in. The values now go to the engine with
  it.
- A GitHub Enterprise host gets the token as GITHUB_ENTERPRISE_TOKEN,
  which is the name gh looks for there: gh ignores GH_TOKEN for an
  enterprise host, so the agent's gh was not logged in to it.
- The host's gh is asked for the token of the host it is logged in to,
  so the token and the host that goes with it agree.
- The gh settings folder is mounted only when there are credentials in
  it. An empty folder hid the credentials a box wrote to the shared
  home, so signing in inside a box (orca-box-login) was lost.

## [1.7.17]

### Fixed
- The macOS build runs on the Intel runner image. `macos-latest` is the
  arm64 image now, and the arm64 pool is much smaller, so the job waited
  a long time for a runner -- twenty-five minutes in one run -- before
  it started.

### Changed
- The CI does less: the program has no npm packages, so the jobs that
  only build it install no dependencies, the release no longer repeats
  the tests that have already run, and the Linux job builds every
  platform once instead of twice.

## [1.7.16]

### Changed
- The project moved to
  https://github.com/ggpwnkthx/orca-container-isolation, and the program
  looks for its releases and its updates there.

## [1.7.15]

### Added
- The GitHub credentials are a mount, and a mount is decided when the box
  is made. A box now carries a label saying whether it was made with
  them, and a launch into a box that has the wrong ones says so and
  says how to start a new box.

### Changed
- The gh token is asked of the host's gh and passed in the environment.
  gh keeps the token in the system credential store -- the keychain on
  macOS, the credential manager on Windows -- and falls back to a plain
  text file only where there is no credential store, so on macOS and
  Windows it was in no file to mount: the mounted folder carried the
  settings and not the token, and the agent found an unauthenticated gh.
  The token is passed by name, so it is not in the command line.
- The setup says what there is to share when `--gh-auth` is used: the
  host's credentials, a token in the environment, or nothing yet, and
  what to do about it.
- The login box gets the GitHub credentials too, so `gh` works in it.

## [1.7.14]

### Added
- The README has a one-line install command for every platform:
  paste it and the program installs itself.

### Changed
- Podman is refused on Windows. The boxes need Docker Desktop's path
  layout and Linux user ids, which Podman's machine does not have, so
  the installer says so and points at Docker Desktop instead of
  failing later, as a box that will not start.

## [1.7.13]

### Changed
- The CI has one job for the program itself and one job for
  each platform's build, and the release is made only when all of
  them have passed.

## [1.7.12]

### Fixed
- The container engine is looked up on the PATH and started by
  its full path, and by its name as well, so that Windows finds it
  whichever way the system resolves a program.

### Changed
- The tests say whether the mock engine itself runs, so that a
  failure says which part is at fault.

## [1.7.11]

### Fixed
- The container engine was found by name, and Windows does not
  always add the .exe extension when a program is started, so it was
  never found there. It is looked up on the PATH and started by its
  full path now.

### Changed
- The release is made with the tag that gh makes, and says in the
  annotations why it could not be made.

## [1.7.10]

### Changed
- The CI no longer copies the test output into the annotations;
  the job log has it.
- A release is now made for every version that reaches the main
  branch: the release workflow makes the tag and attaches the
  executables and their checksums.

## [1.7.9]

### Fixed
- The programs the box starts are now found on the PATH and
  started by their full path, so that Windows finds them without having
  to guess the extension.

## [1.7.8]

### Changed
- The tests say what the program answered when the container engine
  was not called, so that a failure says why.

## [1.7.7]

### Changed
- The CI runs the tests with a longer timeout, so a slow machine
  does not fail them.

## [1.7.6]

### Changed
- The tests follow git for the .git directory too, and for the
  folders inside it, which are joined the way the system writes them.

## [1.7.5]

### Changed
- The tests follow git for the worktree's path now: git writes it
  with the real name of every folder (Windows names its temporary
  folders in the short form) and with forward slashes.

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
