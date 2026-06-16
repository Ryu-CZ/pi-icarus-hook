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
  callTimeoutMs: number;
}

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: Record<string, unknown>;
}

export interface PiApi {
  on: (event: string, handler: (...args: unknown[]) => unknown) => void;
  registerTool: (tool: ToolDefinition & { execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown> }) => void;
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
