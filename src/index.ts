import { IcarusBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { registerConfigIntrospection } from "./config-schema.js";
import { bindHooks } from "./hooks.js";
import { registerTools } from "./tools.js";
import type { PiApi } from "./types.js";

export { IcarusBridge, icarusDirUrl } from "./bridge.js";
export { loadConfig } from "./config.js";
export { CONFIG_SCHEMA, configInspection, configSnippet, registerConfigIntrospection } from "./config-schema.js";
export { bindHooks } from "./hooks.js";
export { registerTools } from "./tools.js";
export type { HookResult, IcarusHookControl, PiApi, PiBridgeConfig, PiContext, PiMessage, ToolDefinition } from "./types.js";

export default function extension(pi: PiApi): void {
  const config = loadConfig();
  const bridge = new IcarusBridge(config);

  const hookControl = config.bindHooks ? bindHooks(pi, bridge, config) : undefined;
  if (!config.bindHooks) pi.on("session_shutdown", () => bridge.close());
  registerConfigIntrospection(pi, config, config.registerTools, hookControl);
  if (config.registerTools) registerTools(pi, bridge, config.registerAdminTools);

  process.once("exit", () => bridge.close());
}
