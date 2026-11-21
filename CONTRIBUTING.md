# Contributing

Thanks for helping out.

## The one rule

**`orca.sh` is generated. Do not edit it.**

It is assembled from `src/` by `build.sh`. If you change the sources, run
`./build.sh` and commit the result:

```sh
./build.sh
git add orca.sh
git commit
```

CI runs `./build.sh --check`, which fails if the committed `orca.sh` does not
match the sources. That check is what keeps the two in step.

## Getting set up

You need bash, python3 and (optionally) shellcheck.

```sh
git clone https://github.com/ggpwnkthx/orca-box
cd orca-box
./build.sh
tests/run.sh
```

The tests use a fake container engine, a fake curl and a fake Orca daemon, so
they need neither Podman nor Docker nor Orca.

## Where things live

| Path | What's in it |
| --- | --- |
| `src/header.sh` | the file's header comment |
| `src/globals.sh` | paths, the tool list, the version |
| `src/dispatch.sh` | maps a command name to its function |
| `src/lib/common.sh` | config, output, downloads, engine detection |
| `src/lib/box.sh` | the box itself, plus archive and login |
| `src/lib/configure-orca.sh` | talks to Orca over its local socket |
| `src/lib/install-orca.sh` | the Orca AppImage and its menu entry |
| `src/lib/update.sh` | self-update |
| `src/lib/setup.sh` | the installer |
| `src/python/` | the helper programs (real `.py` files) |
| `src/container/` | the Containerfile and the skill-sync script |

The shell modules are concatenated in the order `build.sh` lists. Keep each
one self-contained: it should not depend on a function defined in a module
that comes later.

## The embedded assets

The Python helpers, the Containerfile and the skill-sync script live in their
own files and are pulled into the shell by an `@@FILE:path@@` marker:

```bash
exec python3 -I - "$action" ... <<'PY'
@@FILE:src/python/orca_client.py@@
PY
```

`build.sh` replaces each marker with the file's contents, so the shipped
`orca.sh` is self-contained and can still be piped to `bash`. Edit the file
under `src/`, never the heredoc in the shell.

## Style

- `shellcheck -S warning` must be clean, for `orca.sh` and for every source.
- Prefer one function per concern; keep them short.
- Comment the *why*, not the *what*.
- User-facing text goes to stdout; diagnostics go to stderr.

## Making a release

```sh
# bump VERSION, then:
./build.sh
git commit -am "v1.2.3"
git tag v1.2.3
git push --follow-tags
```

The release workflow builds, lints, tests and attaches `orca.sh` to the
GitHub Release. `orca-box-update` fetches the latest release, so a tagged
release is what users get; `main` stays the moving target.

## Reporting a bug

Open an issue with what you ran, what you expected and what happened. If it
involves a container, include the output of `orca-box-setup` and your
`~/.config/orca-box/config`.
