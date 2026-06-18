import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type SettingsScope = "global" | "project";

const PACKAGE_KEYS = ["piIcarusHook", "pi-icarus-hook", "icarusHook"] as const;

interface SettingsDocument {
  [key: string]: unknown;
}

export interface PackageSettingInspection {
  value: boolean;
  source: SettingsScope | "built-in";
  path?: string;
  packageKey?: string;
}

export interface PackageSettingWriteResult {
  scope: SettingsScope;
  path: string;
  packageKey: string;
  value: boolean;
}

function expandPath(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function resolvePath(value: string, baseDir = process.cwd()): string {
  const expanded = expandPath(value);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

function boolValue(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return !["0", "false", "no", "off", "disabled"].includes(value.trim().toLowerCase());
  return fallback;
}

export function settingsPath(scope: SettingsScope, cwd = process.cwd()): string {
  if (scope === "project") return join(resolve(cwd), ".pi", "settings.json");
  const agentDir = process.env.PI_CODING_AGENT_DIR ? resolvePath(process.env.PI_CODING_AGENT_DIR) : join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

async function readSettingsDocument(path: string): Promise<SettingsDocument> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SettingsDocument : {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

function packageSection(document: SettingsDocument): { key: string; section: Record<string, unknown> } | undefined {
  for (const key of PACKAGE_KEYS) {
    const section = document[key];
    if (section && typeof section === "object" && !Array.isArray(section)) return { key, section: section as Record<string, unknown> };
  }
  return undefined;
}

async function readSettingFromScope(scope: SettingsScope, cwd: string, settingKey: string): Promise<PackageSettingInspection | undefined> {
  const path = settingsPath(scope, cwd);
  const document = await readSettingsDocument(path);
  const existing = packageSection(document);
  if (!existing || existing.section[settingKey] === undefined) return undefined;
  return {
    value: boolValue(existing.section[settingKey], true),
    source: scope,
    path,
    packageKey: existing.key,
  };
}

export async function inspectBooleanPackageSettingScope(scope: SettingsScope, settingKey: string, builtInDefault: boolean, cwd = process.cwd()): Promise<PackageSettingInspection> {
  return await readSettingFromScope(scope, cwd, settingKey)
    ?? { value: builtInDefault, source: "built-in", path: settingsPath(scope, cwd), packageKey: PACKAGE_KEYS[0] };
}

export async function inspectBooleanPackageSetting(settingKey: string, builtInDefault: boolean, cwd = process.cwd()): Promise<PackageSettingInspection> {
  return await readSettingFromScope("project", cwd, settingKey)
    ?? await readSettingFromScope("global", cwd, settingKey)
    ?? { value: builtInDefault, source: "built-in" };
}

export async function chooseBooleanPackageSettingScope(settingKey: string, cwd = process.cwd(), requestedScope?: SettingsScope): Promise<SettingsScope> {
  if (requestedScope) return requestedScope;
  if (await readSettingFromScope("project", cwd, settingKey)) return "project";
  if (await readSettingFromScope("global", cwd, settingKey)) return "global";
  return "global";
}

export async function writeBooleanPackageSetting(scope: SettingsScope, cwd: string, settingKey: string, value: boolean): Promise<PackageSettingWriteResult> {
  const path = settingsPath(scope, cwd);
  const document = await readSettingsDocument(path);
  const existing = packageSection(document);
  const packageKey = existing?.key ?? PACKAGE_KEYS[0];
  const section = { ...(existing?.section ?? {}) };
  section[settingKey] = value;
  document[packageKey] = section;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { scope, path, packageKey, value };
}
