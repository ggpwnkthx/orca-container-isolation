/**
 * Finding programs on PATH.
 *
 * This does the work itself rather than shelling out to `which`, for two
 * reasons: `which` is not on every system (NixOS and some minimal installs
 * don't have it), and a missing program makes the runtime throw rather than
 * return a status, which turns "not installed" into a crash.
 */

import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { isWindows } from "./platform.ts";

/** Is there an executable by this name on PATH? */
export function hasCommand(name: string): boolean {
  return findCommand(name) !== "";
}

/**
 * The full path of a program on PATH, or "" if it isn't there.
 *
 * Windows keeps the extension: the program is podman.exe, and the name
 * the program asks for is podman. The path is returned rather than the
 * name, so that the program can be started without the system having
 * to guess the extension.
 */
export function findCommand(name: string): string {
  if (name.includes("/") || name.includes("\\")) {
    return isExecutable(name) ? name : "";
  }
  const path = process.env.PATH ?? "";
  const names = isWindows() ? [name, `${name}.exe`] : [name];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const candidate of names) {
      const full = join(dir, candidate);
      if (isExecutable(full)) return full;
    }
  }
  return "";
}

/** Is this path a file we can run? */
function isExecutable(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a program if it is there, and do nothing if it isn't.
 *
 * Returns the exit status, or -1 when the program isn't installed.
 */
export function runIfPresent(
  bin: string,
  args: string[],
  options: Parameters<typeof Bun.spawnSync>[1] = { stdout: "ignore", stderr: "ignore" },
): number {
  // The full path, so that the program is started without the system
  // having to guess the extension (Windows keeps it).
  const full = findCommand(bin);
  if (!full) return -1;
  try {
    return Bun.spawnSync([full, ...args], options).exitCode ?? 0;
  } catch {
    return -1;
  }
}
