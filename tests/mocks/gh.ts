/**
 * A fake GitHub CLI for the test suite.
 *
 * orca-box asks the host's gh for the token it is logged in with, because
 * on macOS and Windows the token is in the system credential store and in
 * no file. This answers that one question.
 *
 * Environment:
 *   FAKE_GH_TOKEN   the token to answer with; empty means "not logged in"
 *   FAKE_GH_HOST    the host it is logged in to. When it is not set, the
 *                   token is given for any host that is asked for.
 *   FAKE_LOG        file to append what was asked to, so a test can see
 *                   that the host's gh was the one that answered
 */

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);

const log = process.env.FAKE_LOG;
if (log) {
  try {
    appendFileSync(log, `GH ${args.join(" ")}\n`);
  } catch {
    // The log is for the tests to read; the answer still has to be given.
  }
}

if (args[0] === "auth" && args[1] === "token") {
  // An empty FAKE_GH_TOKEN means "not logged in", the way gh answers when
  // there is no credential.
  const token = process.env.FAKE_GH_TOKEN ?? "gho_testtoken";
  if (!token) process.exit(1);
  // gh asks for the token of a host by name.
  const at = args.indexOf("--hostname");
  if (at >= 0) {
    const host = args[at + 1] ?? "";
    const loggedIn = process.env.FAKE_GH_HOST;
    if (loggedIn && host !== loggedIn) {
      process.stderr.write(`no oauth token found for ${host}\n`);
      process.exit(1);
    }
  }
  console.log(token);
  process.exit(0);
}

process.exit(1);
