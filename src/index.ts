import { IcarusBridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { registerConfigIntrospection } from "./config-schema.js";
import { bindHooks } from "./hooks.js";
import { registerTools } from "./tools.js";
import type { PiApi, PiContext } from "./types.js";

export { IcarusBridge, icarusDirUrl } from "./bridge.js";
export { loadConfig } from "./config.js";
export { CONFIG_SCHEMA, configInspection, configSnippet, registerConfigIntrospection } from "./config-schema.js";
export { bindHooks } from "./hooks.js";
export { registerTools } from "./tools.js";
export type { HookResult, IcarusHookControl, PiApi, PiBridgeConfig, PiContext, PiMessage, ToolDefinition } from "./types.js";

export default function extension(pi: PiApi): void {
  // Factories also run before Pi decides project trust and in config-only invocations.
  registerConfigIntrospection(pi, loadConfig(), false);
  let initialized = false;
  let onExit: (() => void) | undefined;

  pi.on("session_start", async (event, ctx) => {
    if (initialized) return;
    const context = ctx as PiContext;
    const config = loadConfig(context.cwd, { projectTrusted: context.isProjectTrusted?.() === true });
    const bridge = new IcarusBridge(config);
    initialized = true;

    const hookControl = config.bindHooks ? bindHooks(pi, bridge, config) : undefined;
    if (!config.bindHooks) pi.on("session_shutdown", () => bridge.close());
    registerConfigIntrospection(pi, config, config.registerTools, hookControl);
    if (config.registerTools) registerTools(pi, bridge, config.registerAdminTools);

    onExit = () => bridge.close();
    process.once("exit", onExit);
    // Pi snapshots event handlers: the newly bound hook misses this first dispatch.
    await hookControl?.startSession(event, ctx);
  });
  pi.on("session_shutdown", () => {
    if (onExit) process.removeListener("exit", onExit);
    onExit = undefined;
  });
}
