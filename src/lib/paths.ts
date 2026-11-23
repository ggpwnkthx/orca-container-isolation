/**
 * Where orca-box puts its files.
 *
 * Everything lives in the user's own space: the program and its data under
 * the data directory, the commands under the prefix's bin directory.
 */

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataHome, isWindows } from "./platform.ts";

export interface Paths {
  /** Where the tool's own files live. */
  data: string;
  /** Where the commands are linked. */
  bin: string;
  /** The installed program. */
  program: string;
  /** Where the agent image's Containerfile goes. */
  containerfile: string;
  /** Where the browser wrapper for the image goes. */
  chromium: string;
}

/** The program's paths, for this machine and this user. */
export function paths(): Paths {
  const data = join(dataHome(), "orca-box");
  const prefix = process.env.PREFIX ?? defaultPrefix();
  return {
    data,
    bin: join(prefix, "bin"),
    program: programFileIn(data),
    containerfile: join(data, "Containerfile"),
    chromium: join(data, "chromium.sh"),
  };
}

/**
 * Where the commands go.
 *
 * ~/.local/bin on Linux and macOS; a folder of its own on Windows, where
 * ~/.local is not the usual place for anything.
 */
function defaultPrefix(): string {
  if (isWindows()) {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(local, "orca-box");
  }
  return join(homedir(), ".local");
}

/** The file the program is installed as. */
function programFileIn(data: string): string {
  return isWindows() ? join(data, "orca-box.exe") : join(data, "orca-box");
}

/**
 * Is this the installed program?
 *
 * The program copies itself into place when it is set up, so a copy that
 * is being run from somewhere else is not the installed one yet. A
 * program run from source is not a copy at all: it is never installed.
 */
export function isInstalled(): boolean {
  const entry = process.argv[1] ?? "";
  if (entry.endsWith(".ts")) {
    // Running from a checkout: there is nothing to install.
    return true;
  }
  const { program } = paths();
  if (!existsSync(program)) return false;
  try {
    return realpathSync(process.execPath) === realpathSync(program);
  } catch {
    return false;
  }
}

/** A scratch folder for the installer's temporary files. */
export function dataWork(): string {
  const dir = join(paths().data, "work");
  mkdirSync(dir, { recursive: true });
  return dir;
}
