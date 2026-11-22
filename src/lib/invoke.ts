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

/**
 * The name the program was invoked as.
 *
 * Falls back to argv[1] where /proc is not available.
 */
export function invokeName(argv1?: string): string {
  const fromProc = cmdlineName();
  if (fromProc) return fromProc;
  const fallback = argv1 ?? process.argv[1];
  return fallback ? basename(fallback) : "orca-box";
}

/** The name a command line's first word denotes. */
export function invokeNameFrom(firstWord: string): string {
  return basename(firstWord);
}

/** The first word of this process's command line, if we can read it. */
function cmdlineName(): string | null {
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
