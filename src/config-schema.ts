import type { IcarusHookControl, PiApi, PiBridgeConfig, PiContext } from "./types.js";

export interface ConfigSettingSchema {
  type: "boolean" | "number" | "string";
  default: boolean | number | string;
  aliases?: string[];
  description: string;
}

export interface RuntimeEnvSchema {
  default?: string;
  description: string;
}

export const CONFIG_SCHEMA = {
  key: "piIcarusHook",
  aliases: ["pi-icarus-hook", "icarusHook"],
  locations: [".pi/settings.json", "${PI_CODING_AGENT_DIR:-~/.pi/agent}/settings.json"],
  settings: {
    platform: {
      type: "string",
      default: "pi",
      description: "Platform label passed to Icarus hooks.",
    },
    hooks: {
      type: "boolean",
      default: true,
      aliases: ["bindHooks"],
      description: "Register Pi lifecycle hooks that call Icarus before/after turns.",
    },
    tools: {
      type: "boolean",
      default: true,
      aliases: ["registerTools"],
      description: "Register normal Fabric tools plus the read-only icarus_hook_config introspection tool.",
    },
    adminTools: {
      type: "boolean",
      default: false,
      aliases: ["registerAdminTools"],
      description: "Register admin/training Fabric tools. Keep disabled unless explicitly needed.",
    },
    timeoutMs: {
      type: "number",
      default: 30000,
      aliases: ["callTimeoutMs"],
      description: "Timeout in milliseconds for each call into the persistent Icarus worker.",
    },
    contextDisplay: {
      type: "boolean",
      default: false,
      aliases: ["hiddenDisplay"],
      description: "Show injected Icarus context in the Pi UI instead of hiding it.",
    },
    footerStatus: {
      type: "string",
      default: "🪽 Icarus",
      aliases: ["statusLabel"],
      description: "Footer status text shown while ambient Icarus memory hooks are active.",
    },
  } satisfies Record<string, ConfigSettingSchema>,
  runtimeEnv: {
    ICARUS_DIR: {
      default: "~/.hermes/plugins/icarus",
      description: "Local Icarus Python package directory.",
    },
    ICARUS_PYTHON: {
      default: "python3",
      description: "Python executable used to start the persistent Icarus worker.",
    },
    HERMES_HOME: {
      default: "~/.hermes when present",
      description: "Hermes home used for Icarus state files.",
    },
    FABRIC_DIR: {
      default: "~/fabric",
      description: "Shared Fabric markdown directory.",
    },
    HERMES_AGENT_NAME: {
      description: "Agent identity passed to Icarus; FABRIC_AGENT is also accepted.",
    },
    FABRIC_PROJECT_ID: {
      default: "current directory name",
      description: "Project id passed to Icarus writes and retrieval.",
    },
    STATE_DB_PATH: {
      description: "Explicit Hermes session SQLite path; HERMES_STATE_DB is also accepted.",
    },
  } satisfies Record<string, RuntimeEnvSchema>,
} as const;

export function configSnippet(config: PiBridgeConfig): Record<string, unknown> {
  return {
    [CONFIG_SCHEMA.key]: {
      platform: config.platform,
      hooks: config.bindHooks,
      tools: config.registerTools,
      adminTools: config.registerAdminTools,
      timeoutMs: config.callTimeoutMs,
      contextDisplay: config.hiddenDisplay,
      footerStatus: config.footerStatus,
    },
  };
}

export function configInspection(config: PiBridgeConfig): Record<string, unknown> {
  return {
    package: "pi-icarus-hook",
    schema: CONFIG_SCHEMA,
    effective: {
      icarusDir: config.icarusDir,
      python: config.python,
      fabricDir: config.fabricDir,
      agent: config.agent,
      projectId: config.projectId,
      platform: config.platform,
      hermesHome: config.hermesHome ?? null,
      stateDbPath: config.stateDbPath ?? null,
      hooks: config.bindHooks,
      tools: config.registerTools,
      adminTools: config.registerAdminTools,
      contextDisplay: config.hiddenDisplay,
      footerStatus: config.footerStatus,
      timeoutMs: config.callTimeoutMs,
    },
    settingsSnippet: configSnippet(config),
    note: "Pi behavior keys belong in Pi settings; runtime paths and identity can still come from environment variables.",
  };
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

function notify(ctx: unknown, message: string, level = "info"): void {
  const piContext = ctx && typeof ctx === "object" ? ctx as PiContext : {};
  piContext.ui?.notify?.(message, level);
}

function hookStatusMessage(hookControl: IcarusHookControl | undefined): string {
  if (!hookControl) return "Icarus hooks are not registered because hooks are disabled in Pi settings.";
  return hookControl.isEnabled()
    ? "Icarus memory hooks are on. This conversation can load and save Icarus memory."
    : "Icarus memory hooks are off for this Pi session. This conversation will not load or save Icarus memory.";
}

export function registerConfigIntrospection(pi: PiApi, config: PiBridgeConfig, registerTool: boolean, hookControl?: IcarusHookControl): void {
  pi.registerCommand?.("icarus-hook", {
    description: "Toggle whether this Pi session loads and saves Icarus memory",
    handler: async (args: unknown, ctx: unknown) => {
      const command = typeof args === "string" ? args.trim().toLowerCase().split(/\s+/)[0] : "";
      if (["", "status", "toggle", "on", "enable", "off", "disable"].includes(command)) {
        if (!hookControl) {
          const message = hookStatusMessage(hookControl);
          notify(ctx, message, command === "status" || command === "off" || command === "disable" ? "info" : "warning");
          return message;
        }

        if (command === "" || command === "toggle") hookControl.toggle(ctx);
        else if (command === "on" || command === "enable") hookControl.setEnabled(true, ctx);
        else if (command === "off" || command === "disable") hookControl.setEnabled(false, ctx);

        const message = hookStatusMessage(hookControl);
        notify(ctx, message, "info");
        return message;
      }

      const payload = command === "schema" ? CONFIG_SCHEMA : configInspection(config);
      const text = JSON.stringify(payload, null, 2);
      notify(ctx, text, "info");
      return text;
    },
  });

  if (!registerTool) return;
  pi.registerTool({
    name: "icarus_hook_config",
    label: "Icarus Hook Config",
    description: "Read pi-icarus-hook's configuration schema and current effective config. This is read-only; do not edit settings without explicit user approval.",
    promptSnippet: "Use icarus_hook_config to inspect how pi-icarus-hook is configured and which Pi settings keys are supported.",
    parameters: {
      type: "object",
      properties: {
        schemaOnly: { type: "boolean", description: "Return only the configuration schema." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      return jsonResult(params.schemaOnly ? CONFIG_SCHEMA : configInspection(config));
    },
  });
}
