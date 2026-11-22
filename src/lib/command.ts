/**
 * Which command is this?
 *
 * The program is one file that does several things. The name it was
 * called by says which: it is installed under the name of each command
 * (orca-box, orca-box-archive, ...), and each link acts on its own name.
 *
 * A command can also be named as the first argument, which is how
 * Windows starts them, because Windows cannot run a program through a
 * link: the commands there are small files that call the program.
 */

/** The commands the program knows. */
export const TOOLS = [
  "orca-box",
  "orca-box-archive",
  "orca-box-login",
  "orca-box-configure-orca",
  "orca-box-install-orca",
  "orca-box-update",
  "orca-box-setup",
] as const;

export type Tool = (typeof TOOLS)[number];

export interface Command {
  /** Which command to run. */
  name: string;
  /** Its arguments, without the command's own name. */
  args: string[];
}

/**
 * Work out which command to run.
 *
 * The name the program was called by wins, unless an argument names a
 * command. When neither does, the arguments say: a name that isn't an
 * option is the name of an agent to run, and anything else means the
 * setup.
 */
export function resolveCommand(
  calledAs: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
): Command {
  // The .cmd files on Windows say which command they are.
  const fromEnv = env.ORCA_BOX_TOOL;
  if (fromEnv) {
    return { name: fromEnv, args };
  }

  const first = args[0];
  if (first && (TOOLS as readonly string[]).includes(first)) {
    return { name: first, args: args.slice(1) };
  }

  if ((TOOLS as readonly string[]).includes(calledAs)) {
    return { name: calledAs, args };
  }

  if (first && !first.startsWith("-")) {
    // The name of an agent: run it.
    return { name: "orca-box", args };
  }

  // Neither the name nor an argument says which command this is: it is
  // the setup.
  return { name: "orca-box-setup", args };
}
