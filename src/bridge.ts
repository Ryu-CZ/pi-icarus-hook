import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
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

interface WorkerState {
  child: ChildProcessWithoutNullStreams;
  buffer: string;
  pending: Map<number, PendingCall>;
  retired: boolean;
}

const WORKER_CODE = String.raw`
import sys
# -c prepends the working directory. Remove it before importing even stdlib modules.
sys.path = [path for path in sys.path if path]

import contextlib
import importlib
import importlib.util
import json
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
        with contextlib.redirect_stdout(sys.stderr):
            if "icarus" not in sys.modules:
                # Bind this exact checkout; never fall back to another icarus on sys.path.
                spec = importlib.util.spec_from_file_location(
                    "icarus", sys.argv[1], submodule_search_locations=[sys.argv[2]])
                package = importlib.util.module_from_spec(spec)
                sys.modules["icarus"] = package
                try:
                    spec.loader.exec_module(package)
                except BaseException:
                    sys.modules.pop("icarus", None)
                    raise
            mod = importlib.import_module("icarus." + req["module"])
            fn = getattr(mod, req["function"])
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
  private worker: WorkerState | null = null;
  private nextId = 1;

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
    if (this.worker) this.retire(this.worker, new Error("Icarus worker closed before calls completed"));
  }

  private call(request: Omit<WorkerRequest, "id">): Promise<unknown> {
    const id = this.nextId++;
    const payload: WorkerRequest = { id, ...request };
    const line = `${JSON.stringify(payload)}\n`;
    const worker = this.ensureWorker();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.retire(worker, new Error(
          `Icarus call timed out: ${request.module}.${request.function}; outcome may be indeterminate. Worker session state was reset; calls were not replayed.`,
        ));
      }, this.config.callTimeoutMs);

      worker.pending.set(id, { resolve, reject, timer });
      worker.child.stdin.write(line, (error) => {
        if (error) this.retire(worker, error);
      });
    });
  }

  private ensureWorker(): WorkerState {
    if (this.worker) return this.worker;

    const canonical = (path: string) => {
      try { return realpathSync(path); } catch { return resolve(path); }
    };
    const cwd = canonical(process.cwd());
    // Relative/empty PYTHONPATH entries implicitly trust the current project at Python startup.
    const inheritedPaths = (process.env.PYTHONPATH ?? "").split(delimiter)
      .filter((path) => isAbsolute(path) && canonical(path) !== cwd);
    const icarusDir = resolve(this.config.icarusDir);
    const packageParent = dirname(icarusDir);
    const pythonPath = [packageParent, ...inheritedPaths].join(delimiter);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FABRIC_DIR: this.config.fabricDir,
      HERMES_AGENT_NAME: this.config.agent,
      FABRIC_PROJECT_ID: this.config.projectId,
      PYTHONPATH: pythonPath,
    };
    if (this.config.hermesHome) env.HERMES_HOME = this.config.hermesHome;
    if (this.config.stateDbPath) env.STATE_DB_PATH = resolve(this.config.stateDbPath);

    // Preserve path-valued settings relative to the caller, not the worker's safer cwd.
    const python = /[\\/]/.test(this.config.python) ? resolve(this.config.python) : this.config.python;
    const child = spawn(python, ["-u", "-c", WORKER_CODE, join(icarusDir, "__init__.py"), icarusDir], {
      env,
      cwd: existsSync(packageParent) ? packageParent : homedir(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const worker: WorkerState = { child, buffer: "", pending: new Map(), retired: false };
    this.worker = worker;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(worker, chunk));
    child.stderr.on("data", () => {
      // Icarus diagnostics stay out of the JSON protocol. Pi hooks fail open.
    });
    child.stdin.on("error", (error) => this.retire(worker, error));
    child.stdout.on("error", (error) => this.retire(worker, error));
    child.stderr.on("error", (error) => this.retire(worker, error));
    child.on("exit", () => this.retire(worker, new Error("Icarus worker exited; worker session state was lost")));
    child.on("close", () => this.retire(worker, new Error("Icarus worker closed; worker session state was lost")));
    child.on("error", (error) => this.retire(worker, error));

    return worker;
  }

  private handleStdout(worker: WorkerState, chunk: string): void {
    if (worker.retired) return;
    worker.buffer += chunk;
    for (;;) {
      const newline = worker.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = worker.buffer.slice(0, newline).trim();
      worker.buffer = worker.buffer.slice(newline + 1);
      if (!line) continue;
      this.handleResponse(worker, line);
    }
  }

  private handleResponse(worker: WorkerState, line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }

    const pending = worker.pending.get(response.id);
    if (!pending) return;
    worker.pending.delete(response.id);
    clearTimeout(pending.timer);

    if (response.ok) {
      pending.resolve(response.result);
    } else {
      const error = new Error(response.error || "Icarus call failed");
      if (response.traceback) error.stack = response.traceback;
      pending.reject(error);
    }
  }

  private retire(worker: WorkerState, error: Error): void {
    if (worker.retired) return;
    worker.retired = true;
    if (this.worker === worker) this.worker = null;
    // A deadline must stop the serial queue, not merely discard its eventual responses.
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    worker.child.stdin.destroy();
    for (const pending of worker.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    worker.pending.clear();
    worker.buffer = "";
  }
}

export function icarusDirUrl(config: PiBridgeConfig): string {
  return pathToFileURL(config.icarusDir).toString();
}
