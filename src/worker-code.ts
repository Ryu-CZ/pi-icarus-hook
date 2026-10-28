// Python JSON-lines worker, kept inline so source and compiled installs share the same protocol.
export const WORKER_CODE = String.raw`
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
