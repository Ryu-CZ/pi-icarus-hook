import { IcarusBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { bindHooks } from "./hooks.js";
import { registerTools } from "./tools.js";
import type { PiApi } from "./types.js";

export { IcarusBridge, icarusDirUrl } from "./bridge.js";
export { loadConfig } from "./config.js";
export { bindHooks } from "./hooks.js";
export { registerTools } from "./tools.js";
export type { HookResult, PiApi, PiBridgeConfig, PiMessage, ToolDefinition } from "./types.js";

export default function extension(pi: PiApi): void {
  const config = loadConfig();
  const bridge = new IcarusBridge(config);

  if (config.bindHooks) bindHooks(pi, bridge, config);
  else pi.on("session_shutdown", () => bridge.close());
  if (config.registerTools) registerTools(pi, bridge, config.registerAdminTools);

  process.once("exit", () => bridge.close());
}
