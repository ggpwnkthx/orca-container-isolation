/**
 * Talking to Orca.
 *
 * Orca's app listens on a private unix socket and speaks newline-delimited
 * JSON, the same way its own `orca` CLI does. This module is the client:
 * it finds the socket, checks it is really ours, and makes the two calls the
 * installer needs.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configHome, isMac, isWindows } from "./platform.ts";

const AGENTS = ["claude", "codex", "pi"] as const;
type Agent = (typeof AGENTS)[number];

interface RuntimeFile {
  pid: number;
  authToken?: string;
  transport?: string;
  transports?: { kind?: string; endpoint?: string }[];
}

/** The kinds of transport Orca may publish. */
const TRANSPORT_KINDS = ["unix", "named-pipe"];

export interface SavedCommands {
  [agent: string]: string;
}

/**
 * Where Orca keeps its user data.
 *
 * The app writes orca-runtime.json there. On macOS that is the Library
 * folder; on Linux it is the XDG config folder. Orca may also be told to
 * use another place, so that one is checked first.
 */
export function userDataDir(): string {
  if (process.env.ORCA_USER_DATA_PATH) return process.env.ORCA_USER_DATA_PATH;
  return defaultUserDataDir();
}

/** The default place Orca's user data lives on this platform. */
function defaultUserDataDir(): string {
  if (isMac()) {
    return join(homedir(), "Library", "Application Support", "orca");
  }
  if (isWindows()) {
    // Electron's own folder: %APPDATA%\orca
    const roaming = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(roaming, "orca");
  }
  return join(configHome(), "orca");
}

/** The places Orca's runtime file might be, most likely first. */
function userDataDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.ORCA_USER_DATA_PATH) dirs.push(process.env.ORCA_USER_DATA_PATH);
  dirs.push(defaultUserDataDir());
  if (!isMac() && !isWindows()) {
    // Orca built before the macOS layout, or started with an older
    // config home, may still write here.
    dirs.push(join(homedir(), ".config", "orca"));
  } else if (isMac()) {
    dirs.push(join(homedir(), "Library", "Application Support", "Orca"));
  } else {
    const local = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    dirs.push(join(local, "orca"));
  }
  return dirs;
}

/** Orca's runtime file, which says where its socket is. */
export function runtimeFile(): string {
  const dirs = userDataDirs();
  for (const dir of dirs) {
    const file = join(dir, "orca-runtime.json");
    if (existsSync(file)) return file;
  }
  return join(dirs[0]!, "orca-runtime.json");
}

/** The PID of the running Orca app, and the AppImage it was started from. */
export function runningOrca(): { pid: number; appimage: string } {
  const file = runtimeFile();
  let pid: number;
  try {
    const meta = JSON.parse(readFileSync(file, "utf8")) as RuntimeFile;
    pid = Number(meta.pid);
  } catch {
    return { pid: 0, appimage: "" };
  }
  if (!pid) return { pid: 0, appimage: "" };

  // Is it still alive?
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      // It exists, we just may not signal it.
    } else {
      return { pid: 0, appimage: "" };
    }
  }

  // Which AppImage is it running from? Read it out of the process's
  // environment, the way the app's own CLI does.
  let appimage = "";
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8");
    for (const entry of env.split("\0")) {
      if (entry.startsWith("APPIMAGE=")) {
        appimage = entry.slice("APPIMAGE=".length);
      }
    }
  } catch {
    // Not readable: leave it empty.
  }
  if (!appimage) {
    // macOS has no /proc, and the app is a bundle rather than an
    // AppImage; ask the process list instead.
    appimage = commandOf(pid);
  }
  return { pid, appimage };
}

/**
 * The command line of a process, as it was started.
 *
 * Linux has /proc; macOS has `ps`.
 */
function commandOf(pid: number): string {
  try {
    const proc = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)], {
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

/** Read Orca's runtime file, failing with a clear message if it isn't there. */
function readRuntime(): RuntimeFile {
  const file = runtimeFile();
  let meta: RuntimeFile;
  try {
    meta = JSON.parse(readFileSync(file, "utf8")) as RuntimeFile;
  } catch {
    throw new Error(
      `Orca isn't running (no ${file}). Start Orca and run this again.`,
    );
  }

  try {
    process.kill(Number(meta.pid ?? 0), 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") {
      // It exists, we just may not signal it.
    } else {
      throw new Error(
        "Orca isn't running (stale runtime file). Start Orca and run this again.",
      );
    }
  }
  return meta;
}

/**
 * The socket to talk to, and the token to authenticate with.
 *
 * Like Orca's CLI: never send the token to a socket in a /tmp folder that
 * isn't private to this user.
 */
function endpointAndToken(): { endpoint: string; token: string } {
  const meta = readRuntime();

  const transports = Array.isArray(meta.transports)
    ? meta.transports
    : meta.transport
      ? [{ kind: meta.transport, endpoint: (meta as { endpoint?: string }).endpoint }]
      : [];

  // On Linux and macOS Orca listens on a unix socket; on Windows it
  // listens on a named pipe.
  const endpoint = transports.find((t) => TRANSPORT_KINDS.includes(t?.kind ?? ""))?.endpoint;
  const token = meta.authToken ?? "";
  if (!endpoint || !token) {
    throw new Error(
      `Orca's runtime file ${runtimeFile()} has no local socket or token.`,
    );
  }

  const uid = process.getuid?.() ?? 0;
  // macOS keeps /tmp as a link to /private/tmp, so the socket can be
  // under either name. Windows has named pipes, which have their own
  // permissions, so there is nothing to check there.
  const shortPrefixes = [
    `/tmp/.orca-daemon-${uid}/`,
    `/private/tmp/.orca-daemon-${uid}/`,
  ];
  const shortPrefix = isWindows()
    ? undefined
    : shortPrefixes.find((prefix) => endpoint.startsWith(prefix));
  if (shortPrefix) {
    for (const dir of [
      endpoint.slice(0, endpoint.lastIndexOf("/")),
      join(endpoint.slice(0, endpoint.lastIndexOf("/")), ".."),
    ]) {
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) {
          throw new Error(
            `Orca's socket folder ${dir} isn't private to you; not connecting.`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("socket folder")) throw err;
        throw new Error(
          `Orca's socket folder ${dir} isn't there; not connecting.`,
        );
      }
    }
  }
  return { endpoint, token };
}

/** Make one call to Orca and return the reply. */
async function call(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const { endpoint, token } = endpointAndToken();
  const id = randomUUID();
  const message: Record<string, unknown> = { id, authToken: token, method };
  if (params !== undefined) message.params = params;

  const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out"));
    }, 15_000);

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(message)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line);
        } catch {
          continue;
        }
        // Ignore keepalives and replies to other calls.
        if ("_keepalive" in frame || frame.id !== id) continue;
        clearTimeout(timer);
        socket.end();
        resolve(frame);
        return;
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      reject(new Error("Orca closed the connection before answering. Try again."));
    });
  }).catch((err: Error) => {
    throw new Error(`couldn't reach Orca (${err.message}). Is it running?`);
  });

  return reply;
}

/** Orca's current per-agent command overrides. */
async function currentOverrides(): Promise<Record<string, string> | null> {
  const frame = await call("settings.getAgentLaunch");
  if (!frame.ok) return null;
  const result = (frame.result ?? {}) as { settings?: { agentCmdOverrides?: unknown } };
  const overrides = result.settings?.agentCmdOverrides;
  return typeof overrides === "object" && overrides !== null
    ? (overrides as Record<string, string>)
    : {};
}

/** Ask Orca to change one agent's setting. */
async function mutate(params: Record<string, unknown>): Promise<void> {
  const frame = await call("settings.mutateAgentLaunch", params);
  if (!frame.ok) {
    const err = (frame.error ?? {}) as { message?: string };
    throw new Error(
      `Orca rejected ${JSON.stringify(params)}: ${err.message ?? err}`,
    );
  }
}

/**
 * Is this command one of ours?
 *
 * Our command in any form we've written: orca-box, ~/.local/bin/orca-box,
 * or a full path (including Bazzite's /var/home form).
 */
function isOurs(value: string, boxPath: string): boolean {
  const first = value ? value.split(" ", 1)[0] : "";
  if (!first) return false;
  if (first === "orca-box") return true;
  return realPath(first) === realPath(boxPath);
}

/** Resolve a path, without requiring it to exist. */
function realPath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

export interface ConfigureOptions {
  action: "set" | "unset";
  yolo: boolean;
  boxPath: string;
  savedPath: string;
  prefix: string;
}

/**
 * Point Orca's agents at orca-box, or put back what they had before.
 *
 * The commands that were there before are remembered in savedPath, so
 * --unset can restore them.
 *
 * Returns whether it worked. It does not stop the program: the caller
 * decides what to do about it.
 */
export async function configure(options: ConfigureOptions): Promise<boolean> {
  const { action, yolo, boxPath, savedPath, prefix } = options;

  // What the agents had before we took over.
  let saved: SavedCommands = {};
  if (existsSync(savedPath)) {
    try {
      const parsed = JSON.parse(readFileSync(savedPath, "utf8"));
      if (typeof parsed === "object" && parsed !== null) {
        saved = parsed as SavedCommands;
      }
    } catch {
      saved = {};
    }
  }

  const before = await currentOverrides();
  let failed = false;

  if (action === "set" && before !== null) {
    for (const agent of AGENTS) {
      const old = before[agent] ?? "";
      if (!isOurs(old, boxPath)) {
        saved[agent] = old;
      }
    }
    mkdirSync(join(savedPath, ".."), { recursive: true });
    writeFileSync(savedPath, `${JSON.stringify(saved, null, 2)}\n`);
  }

  for (const agent of AGENTS) {
    const old = before?.[agent] ?? "";
    if (action === "set") {
      const next = `${prefix} ${agent}`;
      await mutate({ type: "command", agent, value: next });
      process.stdout.write(`  ${agent.padEnd(7)} command: ${old || "(default)"} -> ${next}\n`);
      if (yolo) {
        await mutate({ type: "permissions", mode: "yolo", agent });
        process.stdout.write(`  ${agent.padEnd(7)} permissions: Yolo\n`);
      }
    } else {
      if (before === null) {
        process.stdout.write(`  ${agent.padEnd(7)} skipped (couldn't read current setting)\n`);
        failed = true;
      } else if (isOurs(old, boxPath)) {
        const previous = typeof saved[agent] === "string" ? saved[agent] : "";
        await mutate({ type: "command", agent, value: previous });
        process.stdout.write(
          `  ${agent.padEnd(7)} command: ${old} -> ${previous || "(default)"}\n`,
        );
      } else {
        process.stdout.write(`  ${agent.padEnd(7)} left as ${old || "(default)"}\n`);
      }
    }
  }

  if (action === "unset" && !failed) {
    try {
      unlinkSync(savedPath);
    } catch {
      // Already gone.
    }
  }
  return !failed;
}
