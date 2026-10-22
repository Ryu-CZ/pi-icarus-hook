import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { registerConfigIntrospection } from "../src/config-schema.js";
import { bindHooks } from "../src/hooks.js";
import type { PiApi } from "../src/types.js";
import { commandReply, type CommandHandler } from "./pi-test-helpers.js";

test("explicit scoped toggles invert that scope, not the overriding effective value", async t => {
  const root = await mkdtemp(join(tmpdir(), "pi-icarus-scoped-toggle-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(root, { recursive: true, force: true });
  });
  const project = join(root, "project");
  const global = join(root, "global");
  await mkdir(join(project, ".pi"), { recursive: true });
  await mkdir(global);
  process.env.PI_CODING_AGENT_DIR = global;
  const paths = { project: join(project, ".pi", "settings.json"), global: join(global, "settings.json") };
  let handler: CommandHandler | undefined;
  const pi: PiApi = {
    on() { return () => {}; },
    registerTool() {},
    registerCommand(_name, command) { handler = command.handler; },
  };
  const config = loadConfig(project);
  const control = bindHooks(pi, { async hook() {}, close() {} } as never, config);
  registerConfigIntrospection(pi, config, false, control);
  const ctx = { cwd: project, isProjectTrusted: () => true };

  for (const scope of ["global", "project"] as const) {
    for (const original of [false, true]) {
      const otherScope = scope === "global" ? "project" : "global";
      await writeFile(paths[scope], JSON.stringify({ piIcarusHook: { contextDisplay: original } }));
      await writeFile(paths[otherScope], JSON.stringify({ piIcarusHook: { contextDisplay: !original } }));
      const otherBefore = await readFile(paths[otherScope], "utf8");
      const message = await commandReply(handler, `context default toggle ${scope}`, ctx);
      const settings = JSON.parse(await readFile(paths[scope], "utf8"));
      assert.equal(settings.piIcarusHook.contextDisplay, !original, `${scope} toggle from ${original}`);
      assert.equal(await readFile(paths[otherScope], "utf8"), otherBefore);
      assert.match(message, new RegExp(`default saved as ${original ? "hidden" : "visible"} in ${scope} settings`));
      assert.doesNotMatch(message, /will be .* by default/);
      if (scope === "global") assert.match(message, /Project settings may override this global default/);
    }
  }

  const cases = [
    { scope: "global", target: "global", project: { contextDisplay: true }, global: { hiddenDisplay: false }, expected: true },
    { scope: "project", target: "project", project: { hiddenDisplay: true }, global: { contextDisplay: false }, expected: false },
    { scope: "", target: "project", project: { hiddenDisplay: false }, global: { contextDisplay: true }, expected: true },
    { scope: "", target: "global", project: {}, global: { contextDisplay: false }, expected: true },
    { scope: "global", target: "global", project: { contextDisplay: true }, global: {}, expected: false },
    { scope: "project", target: "project", project: {}, global: { contextDisplay: false }, expected: false },
  ] as const;
  for (const entry of cases) {
    for (const scope of ["project", "global"] as const) {
      await writeFile(paths[scope], JSON.stringify({ piIcarusHook: { unrelated: "preserve", ...entry[scope] } }));
    }
    const otherScope = entry.target === "global" ? "project" : "global";
    const otherBefore = await readFile(paths[otherScope], "utf8");
    const message = await commandReply(handler, `context default toggle ${entry.scope}`.trim(), ctx);
    const settings = JSON.parse(await readFile(paths[entry.target], "utf8"));
    assert.equal(settings.piIcarusHook.contextDisplay, entry.expected, JSON.stringify(entry));
    assert.equal(settings.piIcarusHook.unrelated, "preserve");
    const originalSection = entry[entry.target];
    if ("hiddenDisplay" in originalSection) {
      assert.equal(settings.piIcarusHook.hiddenDisplay, originalSection.hiddenDisplay);
    }
    assert.equal(await readFile(paths[otherScope], "utf8"), otherBefore);
    assert.match(message, new RegExp(`default saved as ${entry.expected ? "visible" : "hidden"} in ${entry.target} settings`));
  }
});
