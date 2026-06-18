import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { PiBridgeConfig } from "./types.js";

interface SettingsFile {
  settings: Record<string, unknown>;
  baseDir: string;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
  return fallback;
}

function intValue(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value !== "string" || !value.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandPath(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function resolvePath(value: string, baseDir = process.cwd()): string {
  const expanded = expandPath(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function readSettingsFile(settingsPath: string): SettingsFile | undefined {
  if (!existsSync(settingsPath)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    return { settings, baseDir: dirname(settingsPath) };
  } catch {
    return undefined;
  }
}

function loadSettingsFiles(cwd: string): SettingsFile[] {
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolvePath(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  return [
    readSettingsFile(join(resolve(cwd), ".pi", "settings.json")),
    readSettingsFile(join(agentDir, "settings.json")),
  ].filter((file): file is SettingsFile => file !== undefined);
}

function nested(settings: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return typeof settings[key] === "object" && settings[key] ? settings[key] as Record<string, unknown> : undefined;
}

function packageSettings(settings: Record<string, unknown>): Record<string, unknown> | undefined {
  return nested(settings, "piIcarusHook") || nested(settings, "pi-icarus-hook") || nested(settings, "icarusHook");
}

function firstString(files: SettingsFile[], readers: Array<(settings: Record<string, unknown>) => unknown>): { value: string; baseDir: string } | undefined {
  for (const file of files) {
    for (const read of readers) {
      const value = read(file.settings);
      if (typeof value === "string" && value.trim()) return { value, baseDir: file.baseDir };
    }
  }
  return undefined;
}

function packageString(files: SettingsFile[], keys: string[]): { value: string; baseDir: string } | undefined {
  return firstString(files, keys.map((key) => (settings) => packageSettings(settings)?.[key]));
}

function packageValue(files: SettingsFile[], keys: string[]): unknown {
  for (const file of files) {
    const section = packageSettings(file.settings);
    if (!section) continue;
    for (const key of keys) {
      const value = section[key];
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function loadFabricDir(files: SettingsFile[]): string {
  if (process.env.FABRIC_DIR) return resolvePath(process.env.FABRIC_DIR);

  const configured = firstString(files, [
    (settings) => packageSettings(settings)?.fabricDir,
    (settings) => packageSettings(settings)?.fabric_dir,
    (settings) => settings.fabricDir,
    (settings) => settings.fabric_dir,
    (settings) => nested(settings, "fabric")?.dir,
    (settings) => nested(settings, "fabric")?.fabricDir,
    (settings) => nested(settings, "piFabric")?.dir,
    (settings) => nested(settings, "piFabric")?.fabricDir,
    (settings) => nested(settings, "pi-fabric")?.dir,
    (settings) => nested(settings, "pi-fabric")?.fabricDir,
  ]);
  if (configured) return resolvePath(configured.value, configured.baseDir);

  return join(homedir(), "fabric");
}

function loadHermesHome(files: SettingsFile[]): string | undefined {
  if (process.env.HERMES_HOME) return resolvePath(process.env.HERMES_HOME);
  const configured = packageString(files, ["hermesHome", "hermes_home"]);
  if (configured) return resolvePath(configured.value, configured.baseDir);
  const standard = join(homedir(), ".hermes");
  return existsSync(standard) ? standard : undefined;
}

function loadIcarusDir(hermesHome: string | undefined, files: SettingsFile[]): string {
  if (process.env.ICARUS_DIR) return resolvePath(process.env.ICARUS_DIR);
  const configured = packageString(files, ["icarusDir", "icarus_dir"]);
  if (configured) return resolvePath(configured.value, configured.baseDir);
  if (hermesHome) return join(hermesHome, "plugins", "icarus");
  return join(homedir(), ".hermes", "plugins", "icarus");
}

function inferAgentFromHermesHome(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const base = basename(value.replace(/[\\/]+$/, ""));
  const prefix = ".hermes-";
  return base.startsWith(prefix) && base.length > prefix.length ? base.slice(prefix.length) : undefined;
}

export function loadConfig(cwd = process.cwd()): PiBridgeConfig {
  const settings = loadSettingsFiles(cwd);
  const hermesHome = loadHermesHome(settings);
  return {
    icarusDir: loadIcarusDir(hermesHome, settings),
    python: process.env.ICARUS_PYTHON || packageString(settings, ["python", "icarusPython", "icarus_python"])?.value || "python3",
    fabricDir: loadFabricDir(settings),
    agent: process.env.HERMES_AGENT_NAME || process.env.FABRIC_AGENT || packageString(settings, ["agent", "agentName", "hermesAgentName"])?.value || inferAgentFromHermesHome(hermesHome) || "pi-agent",
    projectId: process.env.FABRIC_PROJECT_ID || packageString(settings, ["projectId", "project_id"])?.value || basename(resolve(cwd)) || "unknown",
    platform: packageString(settings, ["platform"])?.value || "pi",
    hermesHome,
    stateDbPath: process.env.STATE_DB_PATH || process.env.HERMES_STATE_DB || packageString(settings, ["stateDbPath", "state_db_path"])?.value,
    bindHooks: boolValue(packageValue(settings, ["hooks", "bindHooks"]), true),
    registerTools: boolValue(packageValue(settings, ["tools", "registerTools"]), true),
    registerAdminTools: boolValue(packageValue(settings, ["adminTools", "registerAdminTools"]), false),
    hiddenDisplay: boolValue(packageValue(settings, ["contextDisplay", "hiddenDisplay"]), true),
    footerStatus: packageString(settings, ["footerStatus", "statusLabel"])?.value || "🪽 Icarus",
    callTimeoutMs: intValue(packageValue(settings, ["timeoutMs", "callTimeoutMs"]), 30000),
  };
}
