/**
 * Terminal output.
 *
 * say() is the progress voice; warn() and die() report problems. Everything
 * a user might want to read goes to stdout except warnings and errors.
 */

let quiet = false;

/** Silence say(). Used by --quiet. */
export function setQuiet(value: boolean): void {
  quiet = value;
}

export function isQuiet(): boolean {
  return quiet;
}

export function say(message: string): void {
  if (!quiet) {
    process.stdout.write(`\x1b[1m==>\x1b[0m ${message}\n`);
  }
}

export function warn(message: string): void {
  process.stderr.write(`\x1b[33mwarning:\x1b[0m ${message}\n`);
}

/** Report a fatal problem and exit with a non-zero status. */
export function die(message: string, code = 1): never {
  process.stderr.write(`\x1b[31merror:\x1b[0m ${message}\n`);
  process.exit(code);
}

/** Plain output, for the numbered steps of the installer's summary. */
export function plain(message = ""): void {
  process.stdout.write(`${message}\n`);
}
