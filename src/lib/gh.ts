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
 *
 * The token is captured with `gh auth token`, run on the host: only gh
 * knows how to read the system credential store. The host's gh is looked
 * for beyond the PATH as well, because the program is usually started by
 * a desktop app whose PATH is a short one, and gh is then in
 * /opt/homebrew/bin where the app cannot see it. Where gh cannot answer,
 * the token is taken from where gh would have put it: the environment,
 * the settings file, or the macOS keychain.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isMac, isWindows } from "./platform.ts";
import { findCommand, isExecutable } from "./which.ts";

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

/** A host in the gh settings file, and the token in it. */
export interface GhHostEntry {
  /** The host, e.g. "github.com". */
  host: string;
  /** The token in the file for it, or "" when there is none. */
  token: string;
}

/**
 * The hosts in the gh settings file, with the tokens in them.
 *
 * The file is YAML, but only two things are read from it: the hosts (the
 * keys at the left margin) and the token of each host (an oauth_token
 * under it). gh writes the token in plain text only where there is no
 * credential store, which is Linux; elsewhere the token is in the
 * keychain or the credential manager, and this file has none.
 */
export function ghSettingsHosts(): GhHostEntry[] {
  const dir = process.env.GH_CONFIG_DIR ?? defaultGhDir();
  const file = join(dir, "hosts.yml");
  if (!existsSync(file)) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }

  const hosts: GhHostEntry[] = [];
  let current: GhHostEntry | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // A host is a key at the left margin; the accounts under it are
    // indented.
    const host = /^([A-Za-z0-9._-]+):\s*$/.exec(line);
    if (host) {
      const name = (host[1] ?? "").trim();
      current = name ? { host: name, token: "" } : null;
      if (current) hosts.push(current);
      continue;
    }
    // The token, under the host it belongs to.
    const token = /^\s+oauth_token:\s*(\S+)\s*$/.exec(line);
    if (token && current && !current.token) {
      current.token = (token[1] ?? "").replace(/^["']|["']$/g, "");
    }
  }
  return hosts;
}

/** The credentials the host has: a token, and the host it belongs to. */
export interface GhCredentials {
  /** The host the token belongs to, or "" when it is not known. */
  host: string;
  /** The token, or "" when there is none. */
  token: string;
  /** Where the token came from, for the messages. */
  source: string;
  /** Why there is no token, when there is none. */
  reason: string;
}

/**
 * The host the credentials belong to.
 *
 * The host in the environment, the only host in the settings file, or
 * github.com -- which is what gh itself falls back to when it cannot
 * tell. The token and the host have to agree, so both are worked out
 * the same way here.
 */
function hostGhHost(): string {
  if (process.env.GH_HOST) return process.env.GH_HOST;
  const hosts = ghSettingsHosts();
  return hosts.length === 1 ? hosts[0]!.host : "";
}

/**
 * The credentials the host has, if any.
 *
 * The token is captured with `gh auth token`, run on the host: only gh
 * knows about the system credential store -- the login keychain on
 * macOS, the credential manager on Windows -- and that is where the
 * token is on those platforms. The host's gh is looked for beyond the
 * PATH as well, because the program is usually started by a desktop app
 * whose PATH is a short one.
 *
 * Where gh cannot answer, the token is taken from where gh would have
 * put it: the environment, the settings file (where gh writes it in
 * plain text when there is no credential store), or the macOS keychain.
 *
 * The token and the host go together: gh asks for the token of a host by
 * name, so the token that comes back is the one that belongs to the host
 * that is passed on with it.
 */
export function hostGhCredentials(): GhCredentials {
  const hosts = ghSettingsHosts();
  const host = hostGhHost() || "github.com";
  const enterprise = host !== "github.com";

  // 1. The environment, which is where gh looks first.
  const fromEnv = enterprise
    ? process.env.GH_ENTERPRISE_TOKEN ?? process.env.GITHUB_ENTERPRISE_TOKEN
    : process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) {
    return { host, token: fromEnv, source: "the environment", reason: "" };
  }

  // 2. The host's gh, which can read the credential store.
  const gh = findGh();
  if (gh) {
    // The token of that host, so the two agree. gh versions before
    // 2.36 do not know --hostname, so the plain question is the fallback.
    const token = ghToken(gh, ["auth", "token", "--hostname", host]);
    if (token) return { host, token, source: "the host's gh", reason: "" };
    // The host's gh is not logged in to that host, so its token belongs
    // to another one: ask without a host.
    const plain = ghToken(gh, ["auth", "token"]);
    if (plain) return { host, token: plain, source: "the host's gh", reason: "" };
    // gh had nothing to say, but its settings file may still hold the
    // token: that is where gh keeps it where there is no credential
    // store.
    const entry = hosts.find((h) => h.host === host);
    if (entry?.token) {
      return { host, token: entry.token, source: "the gh settings file", reason: "" };
    }
    return {
      host,
      token: "",
      source: "",
      reason: "the host's gh is not logged in",
    };
  }

  // 3. The gh settings file, where gh writes the token in plain text
  // when there is no credential store.
  const entry = hosts.find((h) => h.host === host);
  if (entry?.token) {
    return { host, token: entry.token, source: "the gh settings file", reason: "" };
  }

  // 4. The macOS keychain, where gh keeps the token when there is no
  // gh left to ask about it.
  const keychain = keychainToken(host);
  if (keychain) {
    return { host, token: keychain, source: "the login keychain", reason: "" };
  }

  // Nothing to be had. Say why, but only when there was something to
  // have: a user who signs in inside a box has nothing on the host, and
  // does not need to be told about it every time.
  if (hosts.length > 0) {
    return {
      host,
      token: "",
      source: "",
      reason:
        "the gh settings file has no token in it, and gh is not installed to ask about the credential store",
    };
  }
  return { host, token: "", source: "", reason: "" };
}

/**
 * The GitHub CLI on this host, if it is there.
 *
 * The PATH first, and then the places gh is usually installed in. The
 * program is normally started by a desktop app -- Orca -- and those have
 * a short PATH of their own, so gh in /opt/homebrew/bin or
 * /usr/local/bin would be invisible to them.
 */
export function findGh(): string {
  // The variable go-gh (and gh itself) uses to say where gh is.
  const fromEnv = process.env.GH_PATH;
  if (fromEnv && isExecutable(fromEnv)) return fromEnv;

  const onPath = findCommand("gh");
  if (onPath) return onPath;

  for (const dir of ghInstallDirs()) {
    const full = join(dir, isWindows() ? "gh.exe" : "gh");
    if (isExecutable(full)) return full;
  }
  return "";
}

/** The folders gh is usually installed in. */
function ghInstallDirs(): string[] {
  const home = homedir();
  if (isWindows()) {
    const dirs: string[] = [];
    const programFiles = process.env.ProgramFiles ?? "";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "";
    const local = process.env.LOCALAPPDATA ?? "";
    if (programFiles) dirs.push(join(programFiles, "GitHub CLI", "bin"));
    if (programFilesX86) dirs.push(join(programFilesX86, "GitHub CLI", "bin"));
    if (local) dirs.push(join(local, "Programs", "GitHub CLI", "bin"));
    dirs.push(join(home, "AppData", "Local", "Programs", "GitHub CLI", "bin"));
    return dirs;
  }
  return [
    "/opt/homebrew/bin", // Homebrew on Apple Silicon
    "/usr/local/bin", // Homebrew on Intel, and the manual install
    "/usr/bin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    "/snap/bin",
  ];
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
 * The token in the macOS keychain, where gh keeps it.
 *
 * gh stores it as a generic password whose service is "gh:<host>", which
 * is what the keychain is asked about here. Only macOS has one of these;
 * elsewhere there is nothing to ask.
 */
function keychainToken(host: string): string {
  if (!isMac() || !host) return "";
  try {
    const proc = Bun.spawnSync(
      ["security", "find-generic-password", "-s", `gh:${host}`, "-w"],
      {
        stdout: "pipe",
        stderr: "ignore",
        stdin: "ignore",
      },
    );
    if (proc.exitCode !== 0) return "";
    return new TextDecoder().decode(proc.stdout).trim();
  } catch {
    return "";
  }
}
