/**
 * The GitHub CLI on this host.
 *
 * The CLI itself lives in the agent image, so every box has it. What the
 * host has to share with the boxes is the credentials: gh keeps the token
 * in hosts.yml in its config folder, and a token in the environment counts
 * as well.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isWindows } from "./platform.ts";

/** Where the GitHub CLI keeps its credentials on this platform. */
export function defaultGhDir(): string {
  if (isWindows()) {
    const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(roaming, "GitHub CLI");
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "gh");
}

/**
 * The GitHub credentials the host has, if any.
 *
 * `hasConfig` says whether there is a hosts.yml to share; `hasToken` says
 * whether there is a token in the environment, which needs no files at all.
 */
export function hostGhState(): {
  dir: string;
  hasConfig: boolean;
  hasToken: boolean;
} {
  const dir = process.env.GH_CONFIG_DIR ?? defaultGhDir();
  return {
    dir,
    hasConfig: existsSync(join(dir, "hosts.yml")),
    hasToken: Boolean(process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN),
  };
}
