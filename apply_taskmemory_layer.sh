#!/usr/bin/env bash
set -euo pipefail

# Ensure services directory exists
mkdir -p services

# ----- services/task_memory.py -----
cat <<'PYCODE' > services/task_memory.py
import os, json, sqlite3, threading, datetime, uuid
from typing import Any, Dict, Optional

DEFAULT_DB = os.getenv("TASKMEMORY_DB", os.path.join(os.path.dirname(__file__), "..", "taskmemory.db"))
MAX_PAYLOAD = int(os.getenv("TASKMEMORY_MAX_PAYLOAD", "8192"))  # bytes

_SCHEMA = """
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  route TEXT NOT NULL,
  phase TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session_ts ON events(session_id, ts);
"""

class TaskMemory:
    _lock = threading.Lock()

    def __init__(self, db_path: Optional[str] = None):
        self.db_path = os.path.abspath(db_path or DEFAULT_DB)
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        with self._conn() as con:
            con.executescript(_SCHEMA)

    def _conn(self):
        con = sqlite3.connect(self.db_path, check_same_thread=False)
        con.row_factory = sqlite3.Row
        return con

    @staticmethod
    def new_session_id() -> str:
        return uuid.uuid4().hex

    @staticmethod
    def _now_iso() -> str:
        return datetime.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

    @staticmethod
    def _to_json(payload: Dict[str, Any]) -> str:
        try:
            s = json.dumps(payload, ensure_ascii=False)
        except Exception:
            s = json.dumps({"_warning": "non-serializable payload"})
        if len(s) > MAX_PAYLOAD:
            s = s[:MAX_PAYLOAD] + "...(truncated)"
        return s

    def log_event(self, session_id: str, route: str, phase: str, payload: Dict[str, Any]) -> None:
        try:
            with self._lock:
                with self._conn() as con:
                    con.execute(
                        "INSERT INTO events(session_id, ts, route, phase, payload) VALUES (?,?,?,?,?)",
                        (session_id, self._now_iso(), route, phase, self._to_json(payload))
                    )
        except Exception:
            pass  # best-effort logging

    def list_sessions(self, limit: int = 50):
        sql = (
            "SELECT session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, "
            "COUNT(*) AS event_count FROM events GROUP BY session_id "
            "ORDER BY last_ts DESC LIMIT ?"
        )
        with self._conn() as con:
            return [dict(r) for r in con.execute(sql, (limit,)).fetchall()]

    def get_session(self, session_id: str):
        with self._conn() as con:
            rows = con.execute(
                "SELECT id, ts, route, phase, payload FROM events WHERE session_id=? ORDER BY ts ASC, id ASC",
                (session_id,)
            ).fetchall()
            out = []
            for r in rows:
                try:
                    payload = json.loads(r["payload"])
                except Exception:
                    payload = {"raw": r["payload"]}
                out.append({
                    "id": r["id"],
                    "ts": r["ts"],
                    "route": r["route"],
                    "phase": r["phase"],
                    "payload": payload
                })
            return out
PYCODE

# ----- app.py -----
cat <<'PYCODE' > app.py
import os
from zipfile import ZipFile, ZIP_DEFLATED
from flask import Flask, render_template, request, jsonify, send_from_directory, session
from dotenv import load_dotenv

load_dotenv()  # loads OPENAI_API_KEY, FLASK_SECRET_KEY, etc.

from services.orchestrator import BuildOrchestrator
from services.fixer import FixService
from services.knowledge import KnowledgeService
from services.task_memory import TaskMemory

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-not-secret")

BASE_DIR = os.path.dirname(__file__)
app.config["UPLOAD_FOLDER"] = os.path.join(BASE_DIR, "uploads")
app.config["OUTPUTS_DIR"]  = os.path.join(BASE_DIR, "outputs")
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["OUTPUTS_DIR"], exist_ok=True)

orchestrator = BuildOrchestrator(outputs_dir=app.config["OUTPUTS_DIR"])
fixer = FixService()
knower = KnowledgeService(outputs_dir=app.config["OUTPUTS_DIR"])
tm = TaskMemory(os.getenv("TASKMEMORY_DB"))

# ---- helpers ----
def get_tm_session() -> str:
    sid = session.get("tm_session_id")
    if not sid:
        sid = TaskMemory.new_session_id()
        session["tm_session_id"] = sid
    return sid

def scrub(data):
    bad = ("key", "token", "secret", "password")
    return {k: v for k, v in data.items() if k and not any(b in k.lower() for b in bad)}

# ---------- Pages ----------
@app.route("/")
def home():
    return render_template("home.html", job=None)

@app.route("/build", methods=["GET", "POST"])
def build():
    return render_template("build.html", job=None, steps=[])

@app.route("/fix", methods=["GET", "POST"])
def fix():
    return render_template("fix.html", fix_report=None)

@app.route("/know", methods=["GET", "POST"])
def know():
    return render_template("know.html", answer=None)

# ---------- API: Build ----------
@app.route("/api/build/plan", methods=["POST"])
def api_build_plan():
    sid = get_tm_session()
    form = {k: request.form.get(k) for k in request.form}
    tm.log_event(sid, "/api/build/plan", "request", {"form": scrub(form)})
    summary = request.form.get("summary", "")
    gen_tests = request.form.get("gen_tests") in ("on", "true", "1")
    package  = request.form.get("package_outputs") in ("on", "true", "1")
    res = orchestrator.plan(summary, gen_tests, package)
    tm.log_event(sid, "/api/build/plan", "response", res.__dict__)
    return jsonify(res.__dict__)

@app.route("/api/build/scaffold", methods=["POST"])
def api_build_scaffold():
    sid = get_tm_session()
    tm.log_event(sid, "/api/build/scaffold", "request", {})
    res = orchestrator.scaffold()
    tm.log_event(sid, "/api/build/scaffold", "response", res.__dict__)
    return jsonify(res.__dict__)

@app.route("/api/build/tests", methods=["POST"])
def api_build_tests():
    sid = get_tm_session()
    tm.log_event(sid, "/api/build/tests", "request", {})
    res = orchestrator.tests()
    tm.log_event(sid, "/api/build/tests", "response", res.__dict__)
    return jsonify(res.__dict__)

@app.route("/api/build/package", methods=["POST"])
def api_build_package():
    sid = get_tm_session()
    tm.log_event(sid, "/api/build/package", "request", {})
    res = orchestrator.package()
    zip_path = os.path.join(app.config["OUTPUTS_DIR"], "build.zip")
    with ZipFile(zip_path, "w", ZIP_DEFLATED) as z:
        for fn in os.listdir(app.config["OUTPUTS_DIR"]):
            fp = os.path.join(app.config["OUTPUTS_DIR"], fn)
            if os.path.isfile(fp):
                z.write(fp, arcname=fn)
    tm.log_event(sid, "/api/build/package", "response", res.__dict__)
    return jsonify(res.__dict__)

@app.route("/api/artifacts", methods=["GET"])
def api_artifacts():
    files = []
    for fn in sorted(os.listdir(app.config["OUTPUTS_DIR"])):
        path = os.path.join(app.config["OUTPUTS_DIR"], fn)
        if os.path.isfile(path):
            files.append({"name": fn, "size": os.path.getsize(path)})
    return jsonify({"files": files})

@app.route("/outputs/<path:filename>")
def serve_outputs(filename):
    return send_from_directory(app.config["OUTPUTS_DIR"], filename, as_attachment=False)

# ---------- API: Fix ----------
@app.route("/api/fix", methods=["POST"])
def api_fix():
    sid = get_tm_session()
    form = {k: request.form.get(k) for k in request.form}
    tm.log_event(sid, "/api/fix", "request", {"form": scrub(form)})
    error_text = request.form.get("error") or ""
    snippet    = request.form.get("snippet") or ""
    criteria   = request.form.get("criteria") or ""
    report = fixer.generate_fix(error_text, snippet, criteria)
    payload = {"diff": report.diff, "risk_notes": report.risk_notes}
    tm.log_event(sid, "/api/fix", "response", payload)
    return jsonify(payload)

@app.route("/api/fix/apply", methods=["POST"])
def api_fix_apply():
    sid = get_tm_session()
    diff_text = request.form.get("diff") or ""
    tm.log_event(sid, "/api/fix/apply", "request", {"diff_len": len(diff_text)})
    ok = fixer.apply_patch(diff_text)
    tm.log_event(sid, "/api/fix/apply", "response", {"applied": ok})
    return jsonify({"applied": ok})

# ---------- API: Know ----------
@app.route("/api/know", methods=["POST"])
def api_know():
    sid = get_tm_session()
    q = request.form.get("question") or ""
    tm.log_event(sid, "/api/know", "request", {"question": q})
    ans = knower.ask(q)
    payload = {"answer": ans.answer, "sources": ans.sources}
    tm.log_event(sid, "/api/know", "response", payload)
    return jsonify(payload)

# ---------- API: TaskMemory (read-only) ----------
@app.route("/api/memory/sessions", methods=["GET"])
def api_memory_sessions():
    limit = int(request.args.get("limit", "50"))
    return jsonify({"sessions": tm.list_sessions(limit=limit)})

@app.route("/api/memory/session/<session_id>", methods=["GET"])
def api_memory_session(session_id):
    return jsonify({"events": tm.get_session(session_id)})

@app.route("/api/memory/export/<session_id>", methods=["GET"])
def api_memory_export(session_id):
    return jsonify(tm.get_session(session_id))

if __name__ == "__main__":
    app.run(debug=True)
PYCODE

echo "TaskMemory layer applied. Run: python app.py"
