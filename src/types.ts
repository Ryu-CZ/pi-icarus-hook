import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface PiBridgeConfig {
  icarusDir: string;
  python: string;
  fabricDir: string;
  agent: string;
  projectId: string;
  platform: string;
  hermesHome?: string;
  stateDbPath?: string;
  bindHooks: boolean;
  registerTools: boolean;
  registerAdminTools: boolean;
  hiddenDisplay: boolean;
  footerStatus: string;
  callTimeoutMs: number;
  classifier?: string;
  classifierTimeoutMs?: number;
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: Record<string, unknown>;
}

export type PiApi = Pick<ExtensionAPI, "on" | "registerTool"> &
  Partial<Pick<ExtensionAPI, "sendMessage" | "registerCommand" | "appendEntry">>;

export interface PiContext {
  modelRegistry?: Pick<ExtensionContext["modelRegistry"], "getAvailableOfType" | "classify">;
  signal?: AbortSignal;
  cwd?: string;
  isProjectTrusted?: () => boolean;
  sessionManager?: { getSessionId: () => string };
  ui?: {
    setStatus?: (key: string, value: string | undefined) => void;
    notify?: (message: string, level?: string) => void;
  };
}

export interface IcarusHookControl {
  startSession: (event: unknown, ctx: unknown) => Promise<void>;
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean, ctx?: unknown) => void;
  toggle: (ctx?: unknown) => boolean;
  isContextVisible: () => boolean;
  setContextVisible: (visible: boolean) => void;
  toggleContextVisible: () => boolean;
}

export interface PiMessage {
  customType: string;
  content: string;
  display: boolean;
}

export interface HookResult {
  context?: string;
  [key: string]: unknown;
}
