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

/** Is there an executable by this name on PATH? */
export function hasCommand(name: string): boolean {
  if (name.includes("/")) {
    return isExecutable(name);
  }
  const path = process.env.PATH ?? "";
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    if (isExecutable(join(dir, name))) return true;
  }
  return false;
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
  if (!hasCommand(bin)) return -1;
  try {
    return Bun.spawnSync([bin, ...args], options).exitCode ?? 0;
  } catch {
    return -1;
  }
}
