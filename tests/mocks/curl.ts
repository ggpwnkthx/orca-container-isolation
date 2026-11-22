/**
 * A fake curl for the test suite.
 *
 * It serves files from tests/fixtures/ so the download paths can be tested
 * without a network. Any other URL fails, like a real curl would.
 *
 * Environment:
 *   FAKE_LOG       file to append the command log to
 *   FAKE_FIXTURES  directory to serve files from (default: tests/fixtures)
 */

import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const log = process.env.FAKE_LOG ?? "/tmp/fake-curl.log";
appendFileSync(log, `CURL ${process.argv.slice(2).join(" ")}\n`);

const args = process.argv.slice(2);
let out = "";
let url = "";
for (let i = 0; i < args.length; i++) {
  const arg = args[i] ?? "";
  if (arg === "-o") {
    out = args[i + 1] ?? "";
    i++;
  } else if (
    arg === "-w" ||
    arg === "--proto" ||
    arg === "--tlsv1.2" ||
    arg === "--retry" ||
    arg === "--connect-timeout" ||
    arg === "--max-time"
  ) {
    // A flag with a value.
    if (arg === "-w") i++;
    continue;
  } else if (arg.startsWith("-")) {
    continue;
  } else {
    url = arg;
  }
}

const fixtures =
  process.env.FAKE_FIXTURES ?? join(dirname(process.argv[1] ?? ""), "..", "fixtures");
const name = url.split("/").pop() ?? "";
const source = join(fixtures, name);

if (existsSync(source)) {
  if (out) {
    copyFileSync(source, out);
  } else {
    process.stdout.write(readFileSync(source));
  }
  process.exit(0);
}

process.stderr.write(`curl: (22) mock: no such file: ${source}\n`);
process.exit(22);
