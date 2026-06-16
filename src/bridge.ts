import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import type { PiBridgeConfig } from "./types.js";

interface WorkerRequest {
  id: number;
  module: "hooks" | "tools" | "state" | "obsidian" | "parsing";
  function: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  traceback?: string;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
}

const WORKER_CODE = String.raw`
import contextlib
import importlib
import json
import sys
import traceback

protocol_out = sys.stdout

def write(payload):
    protocol_out.write(json.dumps(payload, default=str, ensure_ascii=False) + "\n")
    protocol_out.flush()

def normalize(value):
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            try:
                return json.loads(stripped)
            except Exception:
                return value
    return value

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        mod = importlib.import_module("icarus." + req["module"])
        fn = getattr(mod, req["function"])
        with contextlib.redirect_stdout(sys.stderr):
            result = fn(*(req.get("args") or []), **(req.get("kwargs") or {}))
        write({"id": req["id"], "ok": True, "result": normalize(result)})
    except Exception as exc:
        write({
            "id": req.get("id"),
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(),
        })
`;

export class IcarusBridge {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<number, PendingCall>();

  constructor(private readonly config: PiBridgeConfig) {}

  async hook(name: string, kwargs: Record<string, unknown> = {}): Promise<unknown> {
    return this.call({ module: "hooks", function: name, kwargs });
  }

  async tool(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.call({ module: "tools", function: name, args: [params] });
  }

  async state(name: string, ...args: unknown[]): Promise<unknown> {
    return this.call({ module: "state", function: name, args });
  }

  close(): void {
    const child = this.child;
    this.child = null;
    if (child && !child.killed) child.kill();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Icarus worker closed before call ${id} completed`));
    }
    this.pending.clear();
  }

  private call(request: Omit<WorkerRequest, "id">): Promise<unknown> {
    const child = this.ensureWorker();
    const id = this.nextId++;
    const payload: WorkerRequest = { id, ...request };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Icarus call timed out: ${request.module}.${request.function}`));
      }, this.config.callTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private ensureWorker(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) return this.child;

    const pythonPath = [dirname(this.config.icarusDir), process.env.PYTHONPATH].filter(Boolean).join(":");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FABRIC_DIR: this.config.fabricDir,
      HERMES_AGENT_NAME: this.config.agent,
      FABRIC_PROJECT_ID: this.config.projectId,
      PYTHONPATH: pythonPath,
    };
    if (this.config.hermesHome) env.HERMES_HOME = this.config.hermesHome;
    if (this.config.stateDbPath) env.STATE_DB_PATH = this.config.stateDbPath;

    const child = spawn(this.config.python, ["-u", "-c", WORKER_CODE], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", () => {
      // Icarus diagnostics stay out of the JSON protocol. Pi hooks fail open.
    });
    child.on("exit", () => this.handleExit());
    child.on("error", (error) => this.rejectAll(error));

    this.child = child;
    return child;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleResponse(line);
    }
  }

  private handleResponse(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const error = new Error(response.error || "Icarus call failed");
      if (response.traceback) error.stack = response.traceback;
      pending.reject(error);
    }
  }

  private handleExit(): void {
    this.child = null;
    this.rejectAll(new Error("Icarus worker exited"));
  }

  private rejectAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function icarusDirUrl(config: PiBridgeConfig): string {
  return pathToFileURL(config.icarusDir).toString();
}
