import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_BASE_URL = "https://api.ploid.com";

type FileConfig = { api_key?: string; base_url?: string };

export function configPath(): string {
  const configured = process.env.XDG_CONFIG_HOME;
  const root = configured?.trim() ? configured : join(homedir(), ".config");
  return join(root, "ploid", "config.json");
}

function readConfig(): FileConfig {
  try {
    const value = JSON.parse(readFileSync(configPath(), "utf8")) as unknown;
    return value && typeof value === "object" ? value as FileConfig : {};
  } catch {
    return {};
  }
}

function writeConfig(path: string, value: FileConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

export function resolveConfig(): { apiKey?: string; baseUrl: string } {
  const file = readConfig();
  return {
    apiKey: process.env.PLOID_API_KEY ?? file.api_key,
    baseUrl: (process.env.PLOID_API_BASE_URL ?? file.base_url ?? DEFAULT_BASE_URL).replace(/\/+$/, ""),
  };
}

export function saveCredentials(apiKey: string, baseUrl: string): string {
  const path = configPath();
  const next: FileConfig = { ...readConfig(), api_key: apiKey };
  if (baseUrl !== DEFAULT_BASE_URL) next.base_url = baseUrl;
  writeConfig(path, next);
  return path;
}

export function clearCredentials(): boolean {
  const path = configPath();
  const current = readConfig();
  if (!current.api_key) return false;
  delete current.api_key;
  writeConfig(path, current);
  return true;
}
