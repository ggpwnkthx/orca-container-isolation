/**
 * The name this program was invoked as.
 *
 * The program is installed once and linked under several names
 * (orca-box, orca-box-archive, ...); each link acts on the name it is
 * called by. The name has to survive being run through a symlink, so it
 * comes from the process's command line -- what the kernel saw -- rather
 * than from argv, which the runtime has already resolved.
 */

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { programName } from "./platform.ts";

/**
 * The name this program was invoked as.
 *
 * Falls back to argv[0] where the command line can't be read.
 */
export function invokeName(argv1?: string): string {
  // On Windows the commands are small .cmd files that set this, because
  // Windows cannot run a program through a link.
  const fromTool = process.env.ORCA_BOX_TOOL;
  if (fromTool) return programName(basename(fromTool));

  const fromCmdline = cmdlineName();
  if (fromCmdline) return programName(fromCmdline);
  // The executable itself. A compiled program reports the runtime in
  // argv[0], so execPath is the one that says what was run; it is the
  // resolved path, so a link does not keep its name -- but on the systems
  // where links are used, the command line above has the name already.
  const exec = process.execPath;
  if (exec) return programName(basename(exec));
  const fallback = argv1 ?? process.argv[1];
  return fallback ? programName(basename(fallback)) : "orca-box";
}

/** The name a command line's first word denotes. */
export function invokeNameFrom(firstWord: string): string {
  return programName(basename(firstWord));
}

/**
 * The first word of this process's command line, if we can read it.
 *
 * Linux has /proc; macOS has `ps`, which prints the arguments the process
 * was started with, just like /proc does.
 */
function cmdlineName(): string | null {
  const fromProc = procCmdlineName();
  if (fromProc) return fromProc;
  return psCmdlineName(process.pid);
}

/** The first word of /proc/self/cmdline. */
function procCmdlineName(): string | null {
  try {
    const cmdline = readFileSync("/proc/self/cmdline", "utf8")
      .split("\0")
      .filter(Boolean);
    const first = cmdline[0];
    return first ? basename(first) : null;
  } catch {
    // Not Linux, or no /proc.
    return null;
  }
}

/**
 * The first word of the command line, from `ps`.
 *
 * macOS has no /proc, but `ps -o command=` prints the process's arguments
 * as they were given to it, so a program started through a symlink keeps
 * the link's name.
 */
export function psCmdlineName(pid: number): string | null {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (proc.exitCode !== 0) return null;
    const line = new TextDecoder().decode(proc.stdout).trim();
    if (!line) return null;
    const first = line.split(/\s+/)[0];
    return first ? basename(first) : null;
  } catch {
    // No ps, or it failed.
    return null;
  }
}
