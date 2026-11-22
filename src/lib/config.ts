/**
 * Configuration: ~/.config/orca-box/config.
 *
 * The file holds KEY=VALUE lines, one per setting. Environment variables win
 * over the file; the file wins over the defaults.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configHome } from "./platform.ts";

export const CONFIG_DIR = configHome();
export const CONFIG_FILE_DIR = join(CONFIG_DIR, "orca-box");
export const CONFIG_FILE = join(CONFIG_FILE_DIR, "config");

/** The settings the config file may set. */
export const SETTINGS_KEYS = [
  "ORCA_BOX_GIT",
  "ORCA_BOX_IDLE_SECONDS",
  "ORCA_BOX_MEMORY",
  "ORCA_BOX_IMAGE",
  "ORCA_BOX_HOME_VOLUME",
  "ORCA_BOX_SKILLS",
  "ORCA_BOX_GH_AUTH",
  "ORCA_BOX_NO_NEW_PRIVILEGES",
] as const;

export type SettingKey = (typeof SETTINGS_KEYS)[number];

const DEFAULTS: Record<SettingKey, string> = {
  ORCA_BOX_GIT: "ro",
  ORCA_BOX_IDLE_SECONDS: "120",
  ORCA_BOX_MEMORY: "8g",
  ORCA_BOX_IMAGE: "localhost/orca-agents:latest",
  ORCA_BOX_HOME_VOLUME: "orca-agent-home",
  ORCA_BOX_SKILLS: "1",
  ORCA_BOX_GH_AUTH: "0",
  // Engines that don't know the option (some Docker Desktop versions)
  // turn this off; the setup checks.
  ORCA_BOX_NO_NEW_PRIVILEGES: "1",
};

const known = new Set<string>(SETTINGS_KEYS);

/** Read the config file into the environment, without overriding it. */
export function loadConfig(): void {
  if (!existsSync(CONFIG_FILE)) return;
  let text: string;
  try {
    text = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!known.has(key)) continue;
    // An environment variable wins over the file.
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
  }
}

/** Set a setting in the config file, replacing any earlier line for it. */
export function setConfig(key: SettingKey, value: string): void {
  mkdirSync(CONFIG_FILE_DIR, { recursive: true });
  let existing = "";
  if (existsSync(CONFIG_FILE)) {
    try {
      existing = readFileSync(CONFIG_FILE, "utf8");
    } catch {
      existing = "";
    }
  }
  const kept = existing
    .split("\n")
    .filter((line) => !(line.startsWith(`${key}=`) || line === `${key} =`));
  const next = [...kept.filter((line) => line !== ""), `${key}=${value}`].join("\n");
  // Write via a temporary file and rename, so a reader never sees a
  // half-written config.
  const tmp = join(CONFIG_FILE_DIR, `.config.${process.pid}.tmp`);
  writeFileSync(tmp, `${next}\n`);
  renameSync(tmp, CONFIG_FILE);
}

/** A setting's effective value: environment, then file, then default. */
export function setting(key: SettingKey): string {
  const fromEnv = process.env[key];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return DEFAULTS[key];
}
