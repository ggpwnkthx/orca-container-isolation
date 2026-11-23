/**
 * Self-update: orca-box-update.
 *
 * The update comes from the project's GitHub Releases, so a tagged release
 * is what users get: a broken main branch can never reach them.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setQuiet, say, die, plain, warn } from "./output.ts";
import { hasCommand, runIfPresent } from "./which.ts";
import { paths } from "./paths.ts";
import { isMac, isWindows, programAsset, programAssetUrl } from "./platform.ts";
import { VERSION } from "./version.ts";
import { boxIds, engineBinary, spawnProgram } from "./engine.ts";

/**
 * Where the update is fetched from.
 *
 * Each platform has its own executable in the release, so the name of the
 * asset depends on the machine.
 */
export const SOURCE_URL =
  process.env.ORCA_BOX_SOURCE_URL ?? programAssetUrl();

/** The version of this program. */


export interface UpdateOptions {
  check: boolean;
  agents: boolean;
  orca: boolean;
  restart: boolean;
  quiet: boolean;
  auto: "on" | "off" | "";
}

/** The systemd user units that make the update check automatic. */
function unitPaths(): { units: string; service: string; timer: string } {
  const configHome = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  const units = join(configHome, "systemd", "user");
  return {
    units,
    service: join(units, "orca-box-update.service"),
    timer: join(units, "orca-box-update.timer"),
  };
}

/** The launchd agent that makes the update check automatic on macOS. */
function launchdPath(): string {
  const dir = join(homedir(), "Library", "LaunchAgents");
  return join(dir, "dev.orca-box.update.plist");
}

/** The launchd job's label. */
const LAUNCHD_LABEL = "dev.orca-box.update";

/** The name of the Windows scheduled task. */
const WINDOWS_TASK = "orca-box daily update";

/** Turn the daily update check on or off. */
export function setAutoUpdate(mode: "on" | "off"): void {
  if (isMac()) {
    setAutoUpdateOnMac(mode);
    return;
  }
  if (isWindows()) {
    setAutoUpdateOnWindows(mode);
    return;
  }
  const { units, service, timer } = unitPaths();

  if (mode === "on") {
    if (!hasSystemctl()) {
      die("systemd isn't available; run orca-box-update yourself instead");
    }
    mkdirSync(units, { recursive: true });
    writeFileSync(
      service,
      `[Unit]
Description=Update orca-box from its GitHub Release
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${join(paths().bin, "orca-box-update")} --quiet
`,
    );
    writeFileSync(
      timer,
      `[Unit]
Description=Check for orca-box updates daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
`,
    );
    Bun.spawnSync(["systemctl", "--user", "daemon-reload"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    Bun.spawnSync(["systemctl", "--user", "enable", "--now", "orca-box-update.timer"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    say("Daily orca-box updates are on (orca-box-update --disable-auto to stop).");
    say(
      "They update the script only; see what they did: journalctl --user -u orca-box-update",
    );
    return;
  }

  if (hasSystemctl()) {
    Bun.spawnSync(["systemctl", "--user", "disable", "--now", "orca-box-update.timer"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  for (const file of [service, timer]) {
    try {
      rmSync(file);
    } catch {
      // Not there.
    }
  }
  if (hasSystemctl()) {
    Bun.spawnSync(["systemctl", "--user", "daemon-reload"], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  say("Daily orca-box updates are off.");
}

/**
 * The daily update on macOS: a launchd agent in the user's own
 * LaunchAgents folder.
 *
 * launchd is what macOS uses instead of systemd; the agent is loaded for
 * the user's own login session, so it needs no administrator rights.
 */
function setAutoUpdateOnMac(mode: "on" | "off"): void {
  const plist = launchdPath();

  if (mode === "on") {
    const program = join(paths().bin, "orca-box-update");
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${program}</string>
    <string>--quiet</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${join(homedir(), "Library", "Logs", "orca-box-update.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(homedir(), "Library", "Logs", "orca-box-update.log")}</string>
</dict>
</plist>
`,
    );
    // Load it into this user's session. An agent that is already loaded
    // is taken out first, so turning this on twice is harmless.
    runIfPresent("launchctl", [
      "bootout",
      `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`,
    ]);
    runIfPresent("launchctl", ["bootstrap", `gui/${process.getuid?.() ?? 0}`, plist]);
    say("Daily orca-box updates are on (orca-box-update --disable-auto to stop).");
    return;
  }

  runIfPresent("launchctl", [
    "bootout",
    `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`,
  ]);
  try {
    rmSync(plist);
  } catch {
    // Not there.
  }
  say("Daily orca-box updates are off.");
}

/**
 * The daily update on Windows: a task in the Task Scheduler.
 *
 * The task runs as this user, so it needs no administrator rights.
 */
function setAutoUpdateOnWindows(mode: "on" | "off"): void {
  const exe = join(paths().data, "orca-box.exe");

  if (mode === "on") {
    // The program is one file with several commands: the name of the
    // command is the first argument.
    const command = `"${exe}" orca-box-update --quiet`;
    const done = runIfPresent("schtasks", [
      "/create",
      "/tn",
      WINDOWS_TASK,
      "/tr",
      command,
      "/sc",
      "daily",
      "/st",
      "04:30",
      "/f",
    ]);
    if (done !== 0) {
      die("couldn't add the task to the Task Scheduler; run orca-box-update yourself instead");
    }
    say("Daily orca-box updates are on (orca-box-update --disable-auto to stop).");
    return;
  }

  runIfPresent("schtasks", ["/delete", "/tn", WINDOWS_TASK, "/f"]);
  say("Daily orca-box updates are off.");
}

/** Take the daily update away, whichever way it was set up. */
export function removeAutoUpdate(): void {
  if (isMac()) {
    setAutoUpdateOnMac("off");
    return;
  }
  if (isWindows()) {
    setAutoUpdateOnWindows("off");
    return;
  }
  setAutoUpdate("off");
}

/** Is systemd here? Not on OpenRC systems, or in a plain container. */
function hasSystemctl(): boolean {
  if (isMac()) return false;
  try {
    return (
      hasCommand("systemctl")
    );
  } catch {
    return false;
  }
}

/** Download the latest release into a temporary file. */
async function downloadLatest(dest: string): Promise<string> {
  const response = await fetch(SOURCE_URL, {
    redirect: "follow",
    headers: { "User-Agent": "orca-box-update" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  await Bun.write(dest, response);
  // It has to be runnable: the updater runs it to install itself.
  chmodSync(dest, 0o755);
  await verifyDownload(dest);
  return dest;
}

/**
 * Check the download against the checksum the release publishes.
 *
 * The release has one file with the checksums of all of its programs.
 */
async function verifyDownload(file: string): Promise<void> {
  const sumsUrl = SOURCE_URL.replace(/\/[^/]+$/, "/SHA256SUMS");
  let text = "";
  try {
    const response = await fetch(sumsUrl, {
      redirect: "follow",
      headers: { "User-Agent": "orca-box-update" },
    });
    if (response.ok) text = await response.text();
  } catch {
    // No checksum file where we expected one.
  }

  const asset = programAsset();
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.endsWith(` ${asset}`));
  const want = line ? (line.split(/\s+/)[0] ?? "") : "";

  if (!want) {
    if (process.env.ORCA_BOX_ALLOW_UNVERIFIED === "1") {
      warn(
        `the release publishes no checksum for ${asset}; updating unverified (ORCA_BOX_ALLOW_UNVERIFIED=1)`,
      );
      return;
    }
    die(
      `the release publishes no checksum for ${asset}, so the download can't be verified.\n` +
        "    Set ORCA_BOX_ALLOW_UNVERIFIED=1 to update anyway.",
    );
  }

  const got = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (got !== want) {
    die("the download doesn't match the published checksum; not updating");
  }
  say("Verified SHA-256 against the published checksum");
}

/** The version a program reports. */
function versionOf(path: string): string {
  const proc = Bun.spawnSync([path, "--version"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = new TextDecoder().decode(proc.stdout).trim();
  return out || "unknown";
}

/** Update orca-box. */
export async function update(options: UpdateOptions): Promise<void> {
  if (options.auto) {
    setAutoUpdate(options.auto);
    return;
  }

  const { data } = paths();
  mkdirSync(data, { recursive: true });
  // The name has to end in .exe on Windows, or the program cannot be
  // started while it is checked.
  const tmp = join(
    data,
    isWindows() ? `.update.${process.pid}.exe` : `.update.${process.pid}`,
  );
  const installed = paths().program;

  try {
    await downloadLatest(tmp);
  } catch (err) {
    die(`couldn't download ${SOURCE_URL} (${(err as Error).message})`);
  }

  const newVersion = versionOf(tmp);
  const oldVersion = existsSync(installed) ? versionOf(installed) : "(not installed)";
  const changed = newVersion !== oldVersion;

  if (options.check) {
    if (changed) {
      plain(`Update available: ${oldVersion} -> ${newVersion}. Run: orca-box-update`);
    } else {
      plain(`orca-box is up to date (${oldVersion}).`);
    }
    rmSync(tmp, { force: true });
    return;
  }

  if (!changed && !options.agents && !options.orca) {
    say(`orca-box is up to date (${oldVersion}).`);
    if (options.restart) archiveAll();
    rmSync(tmp, { force: true });
    return;
  }

  // Install the new version, then let it do the rest.
  if (changed) {
    process.stdout.write(`\x1b[1m==>\x1b[0m Updating orca-box: ${oldVersion} -> ${newVersion}\n`);
  }
  const args = [
    "--brief",
    "--no-launch",
    "--keep-boxes",
    options.agents ? "--update" : "--no-build",
    options.orca ? "" : "--no-orca-app",
  ].filter(Boolean);

  const proc = Bun.spawnSync([tmp, ...args], {
    stdout: options.quiet ? "ignore" : "inherit",
    stderr: "inherit",
  });
  rmSync(tmp, { force: true });
  if (proc.exitCode !== 0) {
    die("the update's installer failed; run orca-box-update to see why");
  }

  if (options.restart) {
    say("Removing running boxes so the next launch uses the update");
    archiveAll();
  } else if (changed || options.agents) {
    say("Running boxes switch to the update once they go idle (or: orca-box-update --restart).");
  }
}

/** Remove every box. */
function archiveAll(): void {
  for (const id of boxIds()) {
    spawnProgram(engineBinary(), ["rm", "-f", id], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}
