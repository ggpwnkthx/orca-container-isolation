/**
 * The GitHub CLI on this host.
 *
 * The CLI itself lives in the agent image, so every box has it. What the
 * host has to share with the boxes is the credentials.
 *
 * Where the credentials are is the tricky part. gh keeps the token in the
 * system credential store by default: the login keychain on macOS, the
 * credential manager on Windows, and the secret service on Linux (where it
 * is usually not there, so gh falls back to writing the token in plain
 * text). Only the plain-text fallback ends up in hosts.yml, which is the
 * file that can be mounted into a box -- so on macOS and Windows the
 * mounted folder carries the settings but not the token.
 *
 * So the token is asked for, and passed in the environment, and the
 * folder is mounted as well, for the settings and for Linux.
 *
 * The token comes with the host it belongs to, because gh looks for the
 * token of an enterprise host under another name (GITHUB_ENTERPRISE_TOKEN)
 * and ignores GH_TOKEN there.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isWindows } from "./platform.ts";
import { findCommand } from "./which.ts";

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
 * `hasConfig` says whether there is a hosts.yml to mount; `hasToken` says
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

/** The credentials the host has: a token, and the host it belongs to. */
export interface GhCredentials {
  /** The host the token belongs to, or "" when it is not known. */
  host: string;
  /** The token, or "" when there is none. */
  token: string;
}

/**
 * The credentials the host has, if any.
 *
 * The environment first, then the host's gh: it knows about the keychain
 * and the credential manager, so it can hand over a token that is not in
 * any file.
 *
 * The token and the host go together: gh asks for the token of a host by
 * name, so the token that comes back is the one that belongs to the host
 * that is passed on with it.
 */
export function hostGhCredentials(): GhCredentials {
  const host = hostGhHost();
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return { host, token: fromEnv };

  const gh = findCommand("gh");
  if (!gh) return { host, token: "" };

  if (host) {
    // The token of that host, so the two agree. gh versions before
    // 2.36 do not know --hostname, so the plain question is the fallback.
    const token = ghToken(gh, ["auth", "token", "--hostname", host]);
    if (token) return { host, token };
    // The host's gh is not logged in to that host, so its token belongs
    // to another one: ask without a host, and leave the host unset, so
    // gh in the box asks the host the host's gh asked.
    return { host: "", token: ghToken(gh, ["auth", "token"]) };
  }
  return { host: "", token: ghToken(gh, ["auth", "token"]) };
}

/**
 * The token the host is logged in with, if any.
 */
export function hostGhToken(): string | null {
  return hostGhCredentials().token || null;
}

/** Ask the host's gh for a token. Empty when there is none. */
function ghToken(gh: string, args: string[]): string {
  try {
    const proc = Bun.spawnSync([gh, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    if (proc.exitCode !== 0) return "";
    return new TextDecoder().decode(proc.stdout).trim();
  } catch {
    return "";
  }
}

/**
 * The GitHub host the host's gh is logged in to.
 *
 * The host in the environment, or the only host in hosts.yml. It is empty
 * when there is none, or when there is more than one and nothing says
 * which is the active one.
 */
export function hostGhHost(): string {
  if (process.env.GH_HOST) return process.env.GH_HOST;

  const dir = process.env.GH_CONFIG_DIR ?? defaultGhDir();
  const file = join(dir, "hosts.yml");
  if (!existsSync(file)) return "";
  let hosts: string[] = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      // The hosts are the keys at the left margin; the accounts below
      // them are indented.
      const match = /^([A-Za-z0-9._-]+):\s*$/.exec(line);
      if (match?.[1]) hosts.push(match[1]);
    }
  } catch {
    return "";
  }
  return hosts.length === 1 ? hosts[0]! : "";
}
