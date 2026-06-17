import type { IcarusBridge } from "./bridge.js";
import type { HookResult, PiApi, PiBridgeConfig, PiMessage } from "./types.js";

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

function latestMessage(messages: unknown, role: string): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as Record<string, unknown> | undefined;
    if (message?.role === role) return asText(message.content);
  }
  return "";
}

function eventRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function contextMessage(customType: string, content: string, config: PiBridgeConfig): { message: PiMessage } | void {
  if (!content.trim()) return;
  return { message: { customType, content, display: config.hiddenDisplay } };
}

function sessionIdFrom(event: Record<string, unknown>, ctx?: Record<string, unknown>): string {
  const session = event.session || ctx?.session;
  if (session && typeof session === "object" && typeof (session as Record<string, unknown>).id === "string") {
    return (session as Record<string, unknown>).id as string;
  }
  return typeof event.session_id === "string" ? event.session_id : "";
}

export function bindHooks(pi: PiApi, bridge: IcarusBridge, config: PiBridgeConfig): void {
  pi.on("session_start", async (event: unknown, ctx: unknown) => {
    try {
      const result = await bridge.hook("on_session_start", {
        session_id: sessionIdFrom(eventRecord(event), eventRecord(ctx)),
        platform: config.platform,
      }) as HookResult | null;
      return contextMessage("icarus-session-context", result?.context || "", config);
    } catch {
      return;
    }
  });

  pi.on("before_agent_start", async (event: unknown) => {
    try {
      const record = eventRecord(event);
      const prompt = asText(record.prompt ?? record.message ?? record.user_message);
      if (!prompt) return;
      const result = await bridge.hook("pre_llm_call", {
        session_id: sessionIdFrom(record),
        user_message: prompt,
        is_first_turn: Boolean(record.is_first_turn ?? record.isFirstTurn ?? record.turn === 0),
      }) as HookResult | null;
      return contextMessage("icarus-memory-context", result?.context || "", config);
    } catch {
      return;
    }
  });

  pi.on("agent_end", async (event: unknown) => {
    try {
      const record = eventRecord(event);
      const messages = record.messages;
      await bridge.hook("post_llm_call", {
        session_id: sessionIdFrom(record),
        user_message: latestMessage(messages, "user"),
        assistant_response: latestMessage(messages, "assistant"),
        platform: config.platform,
      });
    } catch {
      return;
    }
  });

  pi.on("session_shutdown", async (event: unknown) => {
    try {
      const record = eventRecord(event);
      await bridge.hook("on_session_end", {
        session_id: sessionIdFrom(record),
        platform: config.platform,
        completed: Boolean(record.completed),
      });
    } catch {
      return;
    } finally {
      bridge.close();
    }
  });
}
