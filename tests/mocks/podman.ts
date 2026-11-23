/**
 * A fake container engine for the test suite.
 *
 * It logs every invocation (so a test can assert on the exact commands the
 * program would run) and answers the few queries the program makes.
 *
 * It is built into an executable by the test suite, so it works the same
 * on Linux, macOS and Windows.
 *
 * Environment:
 *   FAKE_LOG        file to append the command log to
 *   FAKE_EXISTING   1 (default) if a box already exists, 0 if not
 *   FAKE_GIT        the git mode of the existing box (ro/rw)
 *   FAKE_GH         whether the existing box has the gh credentials (0/1)
 */

import { appendFileSync } from "node:fs";

const log = process.env.FAKE_LOG ?? "/tmp/fake-podman.log";
try {
  appendFileSync(log, `PODMAN ${process.argv.slice(2).join(" ")}\n`);
} catch (err) {
  // The log is for the tests to read; the engine still has to answer.
  process.stderr.write(
    `the mock engine could not write its log (${log}): ${(err as Error).message}\n`,
  );
}

const args = process.argv.slice(2);
const existing = process.env.FAKE_EXISTING ?? "1";
const git = process.env.FAKE_GIT ?? "ro";
const gh = process.env.FAKE_GH ?? "0";

switch (args[0]) {
  case "info": {
    // podman info --format '{{json .SecurityOptions}}'
    if (args[1] === "--format") {
      console.log('["name=seccomp,profile=builtin"]');
    }
    break;
  }
  case "version": {
    console.log("4.9.4");
    break;
  }
  case "ps": {
    // ps -aq --filter ... : the ids of matching containers
    if (existing === "1") console.log("deadbeef");
    break;
  }
  case "inspect": {
    // inspect -f FORMAT NAME
    let format = "";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-f") {
        format = args[i + 1] ?? "";
        i++;
      }
    }
    if (format.includes("orca.worktree")) {
      console.log("/tmp");
    } else if (format.includes("State.Running")) {
      if (existing === "1") console.log(`true 2 ${git}`);
    } else if (format.includes("orca.gh")) {
      console.log(gh);
    } else if (format.includes("Name")) {
      console.log("/name");
    }
    break;
  }
  default:
    break;
}

process.exit(0);
