/**
 * Self-update: orca-box-update.
 *
 * The update comes from the project's GitHub Releases, so a tagged release
 * is what users get: a broken main branch can never reach them.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setQuiet, say, die, plain } from "./output.ts";
import { paths } from "./setup.ts";
import { VERSION } from "./version.ts";
import { boxIds, engineBinary } from "./engine.ts";

/** Where the update is fetched from. */
export const SOURCE_URL =
  process.env.ORCA_BOX_SOURCE_URL ??
  "https://github.com/ggpwnkthx/orca-box/releases/latest/download/orca-box";

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

/** Turn the daily update check on or off. */
export function setAutoUpdate(mode: "on" | "off"): void {
  const { units, service, timer } = unitPaths();

  if (mode === "on") {
    if (Bun.spawnSync(["which", "systemctl"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
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

  if (Bun.spawnSync(["which", "systemctl"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0) {
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
  Bun.spawnSync(["systemctl", "--user", "daemon-reload"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  say("Daily orca-box updates are off.");
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
  return dest;
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

  if (Bun.spawnSync(["which", "curl"], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0) {
    die("curl not found");
  }

  const { data } = paths();
  mkdirSync(data, { recursive: true });
  const tmp = join(data, `.update.${process.pid}`);
  const installed = join(data, "orca-box");

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
    Bun.spawnSync([engineBinary(), "rm", "-f", id], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}
