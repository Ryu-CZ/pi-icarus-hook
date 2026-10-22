import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PiApi } from "../src/types.js";

// Fixtures deliberately dispatch partial event/context values to exercise fail-open behavior.
export type TestEventHandler = (...args: any[]) => unknown;
export type CommandHandler = Parameters<NonNullable<PiApi["registerCommand"]>>[1]["handler"];

export async function commandReply(handler: CommandHandler | undefined, args: string, context: unknown): Promise<string> {
  assert.ok(handler);
  const ctx = context as { ui?: { notify?: (message: string, level?: string) => void } };
  let reply = "";
  const result = await handler(args, {
    ...ctx,
    ui: {
      ...ctx.ui,
      notify(message: string, level?: string) {
        reply = message;
        ctx.ui?.notify?.(message, level);
      },
    },
  } as ExtensionCommandContext);
  assert.equal(result, undefined, "Pi commands communicate through UI, not return values");
  return reply;
}
