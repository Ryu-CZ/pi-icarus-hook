import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import lockfile from "proper-lockfile";

export type SettingsScope = "global" | "project";

const PACKAGE_KEYS = ["piIcarusHook", "pi-icarus-hook", "icarusHook"] as const;
const BOOLEAN_SETTING_ALIASES: Record<string, readonly string[]> = {
  // Existing users may still have this key; command inspection must match config loading.
  contextDisplay: ["hiddenDisplay"],
};

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

async function readSettingsDocument(path: string, forWrite = false): Promise<SettingsDocument> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as SettingsDocument;
    if (forWrite) throw new Error(`Cannot update ${path}: settings must be a JSON object`);
    return {};
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    if (forWrite && error instanceof SyntaxError) {
      throw new Error(`Cannot update ${path}: repair invalid JSON before saving settings`, { cause: error });
    }
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
  if (!existing) return undefined;
  const configuredKey = [settingKey, ...(BOOLEAN_SETTING_ALIASES[settingKey] ?? [])]
    .find((key) => existing.section[key] !== undefined);
  if (!configuredKey) return undefined;
  return {
    value: boolValue(existing.section[configuredKey], true),
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
  await mkdir(dirname(path), { recursive: true });
  // Match Pi's FileSettingsStorage lock, including when settings.json does not exist yet.
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 10, minTimeout: 20, maxTimeout: 100, factor: 1.5 },
  });
  try {
    const document = await readSettingsDocument(path, true);
    const existing = packageSection(document);
    const packageKey = existing?.key ?? PACKAGE_KEYS[0];
    const section = { ...(existing?.section ?? {}) };
    section[settingKey] = value;
    document[packageKey] = section;
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return { scope, path, packageKey, value };
  } finally {
    await release();
  }
}
