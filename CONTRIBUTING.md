# Contributing

Thanks for helping out.

## The one rule

**The program is TypeScript, in `src/`. Edit it there.**

`build.sh` compiles `src/` into a single self-contained executable in
`dist/`. The release workflow attaches that executable to the GitHub
Release, so there is nothing to hand-edit outside `src/`.

```sh
bun install        # once
bun test
bun x tsc --noEmit
./build.sh
```

## Getting set up

You need [Bun](https://bun.sh) and git. Bun goes in your own space:

```sh
curl -fsSL https://bun.sh/install | bash   # into ~/.bun
```

Nothing in this project installs anything system-wide, and nothing needs
`sudo`.

## Where things live

| Path | What's in it |
| --- | --- |
| `src/main.ts` | the command line: dispatch by the name invoked |
| `src/lib/box.ts` | the box: mounts, locking, creation, exec |
| `src/lib/config.ts` | `~/.config/orca-box/config` |
| `src/lib/engine.ts` | Podman or Docker |
| `src/lib/orca.ts` | talks to Orca over its private local socket |
| `src/lib/appimage.ts` | the Orca app and its menu entry |
| `src/lib/setup.ts` | the setup: installs the program and configures Orca |
| `src/lib/update.ts` | self-update |
| `src/lib/invoke.ts` | which command was invoked |
| `src/lib/output.ts` | `say` / `warn` / `die` |
| `src/assets/skill-sync.ts` | embeds the two files below |
| `container/Containerfile` | the agent image |
| `container/skill-sync.sh` | links the host's skills into a running box |
| `build.sh` | builds the executable |

The two files in `container/` are embedded into the executable at build
time, so the installed program is a single file with nothing else to
install alongside it.

## Style

- `bun x tsc --noEmit` must be clean.
- `bun test` must pass.
- Prefer one function per concern; keep them short.
- Comment the *why*, not the *what*.
- User-facing text goes to stdout; diagnostics go to stderr.

## Making a release

```sh
# bump VERSION, then:
./build.sh --all
git commit -am "v1.2.3"
git tag v1.2.3
git push --follow-tags
```

The release workflow typechecks, tests, builds every platform and attaches
the executables and their checksums to the GitHub Release. People install
by downloading the executable for their machine and running it; there is
no bootstrapper script. `orca-box-update` fetches the latest release and
checks it against the published checksum, so a tagged release is what users
get; `main` stays the moving target.

## Reporting a bug

Open an issue with what you ran, what you expected and what happened. If it
involves a container, include the output of `orca-box-setup` and your
`~/.config/orca-box/config`.
