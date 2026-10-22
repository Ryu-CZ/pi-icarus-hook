import type { IcarusBridge } from "./bridge.js";
import type { HookResult, IcarusHookControl, PiApi, PiBridgeConfig, PiContext, PiMessage } from "./types.js";

const FOOTER_STATUS_KEY = "icarus";

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.content === "string") return record.content;
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

function eventRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function piContext(value: unknown): PiContext {
  return value && typeof value === "object" ? value as PiContext : {};
}

function setFooterStatus(ctx: unknown, value: string | undefined): void {
  try {
    piContext(ctx).ui?.setStatus?.(FOOTER_STATUS_KEY, value);
  } catch {
    return;
  }
}

function contextMessage(customType: string, content: string, display: boolean): { message: PiMessage } | void {
  if (!content.trim()) return;
  return { message: { customType, content, display } };
}

function sessionId(ctx: unknown): string {
  return piContext(ctx).sessionManager?.getSessionId() ?? "";
}

export function bindHooks(pi: PiApi, bridge: IcarusBridge, config: PiBridgeConfig): IcarusHookControl {
  let enabled = true;
  let contextVisible = config.hiddenDisplay;
  let firstPrompt = true;
  let startedSessionId: string | undefined;
  let pending: { prompt: string; users: string[]; assistant?: Record<string, unknown> } | undefined;
  const control: IcarusHookControl = {
    startSession,
    isEnabled: () => enabled,
    setEnabled(value, ctx) {
      enabled = value;
      setFooterStatus(ctx, enabled ? config.footerStatus : undefined);
    },
    toggle(ctx) {
      enabled = !enabled;
      setFooterStatus(ctx, enabled ? config.footerStatus : undefined);
      return enabled;
    },
    isContextVisible: () => contextVisible,
    setContextVisible(value) {
      contextVisible = value;
    },
    toggleContextVisible() {
      contextVisible = !contextVisible;
      return contextVisible;
    },
  };

  async function startSession(_event: unknown, ctx: unknown): Promise<void> {
    const id = sessionId(ctx);
    // RPC can bind the same fresh runtime twice. Unknown IDs cannot safely be deduplicated.
    if (id && startedSessionId === id) return;
    startedSessionId = id || undefined;
    firstPrompt = true;
    pending = undefined;
    if (!enabled) {
      setFooterStatus(ctx, undefined);
      return;
    }
    setFooterStatus(ctx, config.footerStatus);
    try {
      const result = await bridge.hook("on_session_start", {
        session_id: sessionId(ctx),
        platform: config.platform,
      }) as HookResult | null;
      const startupContext = result?.context || "";
      if (startupContext.trim()) {
        pi.sendMessage?.({
          customType: "icarus-session-context",
          content: startupContext,
          display: contextVisible,
        }, { triggerTurn: false });
      }
    } catch {
      return;
    }
  }
  pi.on("session_start", startSession);

  pi.on("before_agent_start", async (event: unknown, ctx: unknown) => {
    pending = undefined;
    if (!enabled) {
      setFooterStatus(ctx, undefined);
      return;
    }
    setFooterStatus(ctx, config.footerStatus);
    try {
      const record = eventRecord(event);
      if (record.messageType !== "user") return;
      const prompt = asText(record.prompt);
      if (!prompt.trim()) return;
      pending = { prompt, users: [] };
      const isFirstPrompt = firstPrompt;
      firstPrompt = false;
      const result = await bridge.hook("pre_llm_call", {
        session_id: sessionId(ctx),
        user_message: prompt,
        is_first_turn: isFirstPrompt,
      }) as HookResult | null;
      return contextMessage("icarus-memory-context", result?.context || "", contextVisible);
    } catch {
      return;
    }
  });

  pi.on("agent_end", (event: unknown) => {
    if (!pending) return;
    const messages = eventRecord(event).messages;
    if (!Array.isArray(messages)) return;
    for (const value of messages) {
      const message = eventRecord(value);
      if (message.role === "user") {
        const text = asText(message.content);
        if (text.trim()) pending.users.push(text);
      } else if (message.role === "assistant") {
        pending.assistant = message;
      }
    }
  });

  pi.on("agent_settled", async (event: unknown, ctx: unknown) => {
    const run = pending;
    pending = undefined;
    if (!enabled || !run || eventRecord(event).aborted) return;
    if (run.assistant?.stopReason !== "stop") return;
    const response = asText(run.assistant.content);
    if (!response.trim()) return;
    try {
      await bridge.hook("post_llm_call", {
        session_id: sessionId(ctx),
        user_message: run.users.length ? run.users.join("\n\n") : run.prompt,
        assistant_response: response,
        platform: config.platform,
      });
    } catch {
      return;
    }
  });

  pi.on("session_shutdown", async (_event: unknown, ctx: unknown) => {
    pending = undefined;
    try {
      if (!enabled) return;
      await bridge.hook("on_session_end", {
        session_id: sessionId(ctx),
        platform: config.platform,
      });
    } catch {
      return;
    } finally {
      setFooterStatus(ctx, undefined);
      bridge.close();
    }
  });

  return control;
}
