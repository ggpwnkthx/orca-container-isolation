/**
 * Which command is this?
 *
 * The program is one file that does several things. How it is called
 * says which one, and the rules are worth pinning down.
 */

import { describe, expect, test } from "bun:test";

import { resolveCommand } from "../src/lib/command.ts";

describe("the command", () => {
  test("the name it was called by is the command", () => {
    // The program is installed under the name of each command.
    expect(resolveCommand("orca-box", ["claude"])).toEqual({
      name: "orca-box",
      args: ["claude"],
    });
    expect(resolveCommand("orca-box-archive", ["--all"])).toEqual({
      name: "orca-box-archive",
      args: ["--all"],
    });
    expect(resolveCommand("orca-box-login", [])).toEqual({
      name: "orca-box-login",
      args: [],
    });
  });

  test("a command named as the first argument is that command", () => {
    // This is how Windows starts them: one program file, and the name of
    // the command as the first argument.
    expect(resolveCommand("orca-box", ["orca-box-archive", "--all"])).toEqual({
      name: "orca-box-archive",
      args: ["--all"],
    });
  });

  test("the commands on Windows say which they are", () => {
    // The .cmd files set this, because Windows cannot run a program
    // through a link.
    expect(
      resolveCommand("orca-box", ["--all"], { ORCA_BOX_TOOL: "orca-box-archive" }),
    ).toEqual({ name: "orca-box-archive", args: ["--all"] });
  });

  test("a name that isn't a command is the name of an agent", () => {
    // The program was called by a name that isn't one of its commands --
    // a downloaded copy, say -- and given an agent to run.
    expect(resolveCommand("orca-box-linux-x64", ["claude"])).toEqual({
      name: "orca-box",
      args: ["claude"],
    });
  });

  test("nothing to go on means the setup", () => {
    // A downloaded copy, run with no arguments: it sets everything up.
    expect(resolveCommand("orca-box-linux-x64", [])).toEqual({
      name: "orca-box-setup",
      args: [],
    });
    expect(resolveCommand("orca-box-windows-x64.exe", [])).toEqual({
      name: "orca-box-setup",
      args: [],
    });
  });

  test("options mean the setup", () => {
    // The setup takes options; the other commands do not.
    expect(resolveCommand("orca-box-linux-x64", ["--no-orca-app"])).toEqual({
      name: "orca-box-setup",
      args: ["--no-orca-app"],
    });
  });

  test("the update runs the setup with its own options", () => {
    // The updater downloads a copy and runs it to install itself.
    const args = ["--brief", "--no-launch", "--keep-boxes", "--update"];
    expect(resolveCommand(".update.123", args)).toEqual({
      name: "orca-box-setup",
      args,
    });
  });

  test("a command called with no arguments is still that command", () => {
    // "orca-box" with no arguments says how to use it; it does not start
    // installing things.
    expect(resolveCommand("orca-box", [])).toEqual({
      name: "orca-box",
      args: [],
    });
    expect(resolveCommand("orca-box-setup", [])).toEqual({
      name: "orca-box-setup",
      args: [],
    });
  });
});
