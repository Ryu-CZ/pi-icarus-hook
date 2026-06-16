import type { IcarusBridge } from "./bridge.js";
import type { PiApi, ToolDefinition } from "./types.js";

const string = { type: "string" };
const integer = (minimum = 1, maximum?: number) => ({ type: "integer", minimum, ...(maximum ? { maximum } : {}) });
const optionalString = string;

function object(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: true };
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

const fabricTools: ToolDefinition[] = [
  {
    name: "fabric_write",
    label: "Fabric Write",
    description: "Write an entry through Icarus state.write_entry().",
    promptSnippet: "Use fabric_write to persist important tasks, decisions, reviews, research, and notes to the shared Fabric corpus.",
    parameters: object({
      type: string,
      summary: string,
      content: string,
      tags: optionalString,
      status: optionalString,
      outcome: optionalString,
      review_of: optionalString,
      revises: optionalString,
      customer_id: optionalString,
      assigned_to: optionalString,
      training_value: optionalString,
      verified: optionalString,
      evidence: optionalString,
      source_tool: optionalString,
      artifact_paths: optionalString,
    }, ["type", "summary", "content"]),
  },
  {
    name: "fabric_recall",
    label: "Fabric Recall",
    description: "Recall ranked Fabric entries through Icarus state.recall().",
    promptSnippet: "Use fabric_recall to retrieve relevant memories from the shared Fabric corpus by query.",
    parameters: object({ query: string, max_results: integer(1, 100), agent: optionalString, project: optionalString }, ["query"]),
  },
  {
    name: "fabric_search",
    label: "Fabric Search",
    description: "Search Fabric entries through Icarus state.search_entries().",
    promptSnippet: "Use fabric_search for literal search across hot and cold Fabric markdown entries.",
    parameters: object({ query: string, limit: integer(1, 100) }, ["query"]),
  },
  {
    name: "fabric_pending",
    label: "Fabric Pending",
    description: "List pending Fabric work through Icarus state.read_pending().",
    promptSnippet: "Use fabric_pending to inspect open work assigned to this agent and reviews of this agent's work.",
    parameters: object({ customer_id: optionalString }),
  },
  {
    name: "fabric_curate",
    label: "Fabric Curate",
    description: "Update training_value through Icarus state.curate_entry().",
    promptSnippet: "Use fabric_curate to update an entry training_value by frontmatter id.",
    parameters: object({ entry_id: string, training_value: { type: "string", enum: ["high", "normal", "low"] } }, ["entry_id", "training_value"]),
  },
  {
    name: "fabric_brief",
    label: "Fabric Brief",
    description: "Build the Icarus operational brief.",
    promptSnippet: "Use fabric_brief to get pending counts, recent activity, and suggested next action from Fabric.",
    parameters: object({}),
  },
  {
    name: "fabric_init_obsidian",
    label: "Fabric Init Obsidian",
    description: "Initialize Obsidian support through Icarus obsidian.init_obsidian().",
    promptSnippet: "Use fabric_init_obsidian to create Fabric daily and Obsidian support files idempotently.",
    parameters: object({}),
  },
];

const adminTools: ToolDefinition[] = [
  { name: "fabric_export", label: "Fabric Export", description: "Export Icarus training data.", promptSnippet: "Use fabric_export for admin training export.", parameters: object({ mode: optionalString }) },
  { name: "fabric_train", label: "Fabric Train", description: "Start Icarus model training.", promptSnippet: "Use fabric_train only for admin model training.", parameters: object({ model: optionalString, suffix: optionalString, epochs: integer(1), batch_size: integer(1), learning_rate: { type: "number" }, n_checkpoints: integer(1), mode: optionalString, min_pairs: integer(1) }) },
  { name: "fabric_train_status", label: "Fabric Train Status", description: "Check Icarus training status.", promptSnippet: "Use fabric_train_status to check a training job.", parameters: object({ job_id: optionalString }) },
  { name: "fabric_models", label: "Fabric Models", description: "List Icarus model registry.", promptSnippet: "Use fabric_models to inspect the Icarus model registry.", parameters: object({}) },
  { name: "fabric_eval", label: "Fabric Eval", description: "Run Icarus replacement evaluation.", promptSnippet: "Use fabric_eval for admin model evaluation.", parameters: object({ candidate_model: string, base_model: optionalString, sample_count: integer(1) }, ["candidate_model"]) },
  { name: "fabric_switch_model", label: "Fabric Switch Model", description: "Switch active Icarus model.", promptSnippet: "Use fabric_switch_model only when explicitly switching the active model.", parameters: object({ model_id: string, min_eval_score: { type: "number" } }, ["model_id"]) },
  { name: "fabric_rollback_model", label: "Fabric Rollback Model", description: "Rollback active Icarus model.", promptSnippet: "Use fabric_rollback_model only when explicitly rolling back the active model.", parameters: object({}) },
  { name: "fabric_telemetry", label: "Fabric Telemetry", description: "Read Icarus recall telemetry.", promptSnippet: "Use fabric_telemetry to inspect recall telemetry.", parameters: object({ last_n: integer(1, 1000) }) },
  { name: "fabric_report", label: "Fabric Report", description: "Build Icarus corpus health report.", promptSnippet: "Use fabric_report for an admin corpus health report.", parameters: object({}) },
];

export function registerTools(pi: PiApi, bridge: IcarusBridge, includeAdmin: boolean): void {
  for (const definition of includeAdmin ? [...fabricTools, ...adminTools] : fabricTools) {
    pi.registerTool({
      ...definition,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        return jsonResult(await bridge.tool(definition.name, params));
      },
    });
  }
}
