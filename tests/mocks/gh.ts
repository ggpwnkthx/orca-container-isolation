/**
 * A fake GitHub CLI for the test suite.
 *
 * orca-box asks the host's gh for the token it is logged in with, because
 * on macOS and Windows the token is in the system credential store and in
 * no file. This answers that one question.
 */

const args = process.argv.slice(2);

if (args[0] === "auth" && args[1] === "token") {
  // An empty FAKE_GH_TOKEN means "not logged in", the way gh answers when
  // there is no credential.
  const token = process.env.FAKE_GH_TOKEN ?? "gho_testtoken";
  if (!token) process.exit(1);
  console.log(token);
  process.exit(0);
}

process.exit(1);
