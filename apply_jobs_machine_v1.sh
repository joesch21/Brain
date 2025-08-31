#!/usr/bin/env bash
set -euo pipefail

mkdir -p services static/js templates

# --- services/jobs.py ---
cat <<'EOF2' > services/jobs.py
import threading, time, uuid, traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, List, Optional, Callable

_RING = 1000

class _RingLog:
    def __init__(self, cap=_RING):
        self.cap = cap
        self._buf: List[str] = []
        self._lock = threading.Lock()
        self._eof = False
    def write(self, line: str):
        with self._lock:
            if len(self._buf) >= self.cap:
                self._buf.pop(0)
            self._buf.append(line.rstrip("\n"))
    def close(self):
        with self._lock:
            self._eof = True
    def read(self):
        with self._lock:
            return list(self._buf), self._eof

class Job:
    def __init__(self, jtype: str, payload: Dict[str, Any]):
        self.id = uuid.uuid4().hex[:12]
        self.type = jtype
        self.payload = payload or {}
        self.status = "queued"
        self.created = time.time()
        self.updated = self.created
        self.result: Dict[str, Any] = {}
        self.artifacts: List[str] = []
        self._cancel = False
        self.log = _RingLog()
    def to_row(self):
        return {
            "id": self.id, "type": self.type, "status": self.status,
            "created": self.created, "updated": self.updated
        }
    def to_detail(self):
        return {
            **self.to_row(),
            "result": self.result, "artifacts": self.artifacts
        }

class JobQueue:
    def __init__(self, worker_threads: int = 3):
        self.pool = ThreadPoolExecutor(max_workers=worker_threads, thread_name_prefix="job")
        self.jobs: Dict[str, Job] = {}
        self._lock = threading.Lock()

    def _submit(self, fn: Callable[[Job], None], job: Job):
        def wrapper():
            j = job
            j.status = "running"; j.updated = time.time()
            try:
                fn(j)
                if j.status not in ("failed","cancelled"):
                    j.status = "succeeded"
            except Exception:
                j.status = "failed"
                j.result = {"error": traceback.format_exc()}
            finally:
                j.updated = time.time()
                j.log.close()
        self.pool.submit(wrapper)

    def enqueue(self, jtype: str, payload: Dict[str, Any], runner: Callable[[Job], None]) -> Job:
        job = Job(jtype, payload)
        with self._lock:
            self.jobs[job.id] = job
        self._submit(runner, job)
        return job

    def get(self, jid: str) -> Optional[Job]:
        return self.jobs.get(jid)

    def list(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [j.to_row() for j in sorted(self.jobs.values(), key=lambda x: x.updated, reverse=True)]

    def cancel(self, jid: str) -> bool:
        j = self.get(jid)
        if not j or j.status not in ("queued","running"):
            return False
        j._cancel = True
        j.status = "cancelled"
        j.updated = time.time()
        j.log.write("! cancel requested")
        j.log.close()
        return True
EOF2

# --- templates/machine.html ---
cat <<'EOF2' > templates/machine.html
{% extends "_layout.html" %}
{% block title %}Machine Room — CodeCrafter{% endblock %}
{% block content %}
<h1 class="cc-h1">Machine Room</h1>

<div class="cc-toolbar" style="margin-bottom: .75rem;">
  <button id="btn-demo-build" class="cc-btn cc-btn--primary">Run Sample Build</button>
  <button id="btn-demo-fix" class="cc-btn">Run Sample Fix</button>
  <button id="btn-demo-know" class="cc-btn">Run Sample Know</button>
</div>

<div class="cc-two-column">
  <div class="col">
    <section class="cc-card">
      <h2 style="margin:0;">Jobs</h2>
      <div class="cc-artifacts" style="margin-top:.5rem; max-height:65vh; overflow:auto;">
        <table aria-label="Jobs table">
          <thead>
            <tr><th>ID</th><th>Type</th><th>Status</th><th>Updated</th><th>Actions</th></tr>
          </thead>
          <tbody id="jobs-tbody"></tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="col">
    <section class="cc-card" aria-live="polite">
      <div style="display:flex;gap:.5rem;align-items:center;justify-content:space-between;">
        <h2 id="job-title" style="margin:0;">Details</h2>
        <button id="btn-cancel" class="cc-btn cc-btn--danger" disabled>Cancel</button>
      </div>
      <div id="job-detail" class="cc-artifacts" style="margin-top:.5rem;"></div>
      <h3>Logs</h3>
      <pre id="job-logs" class="cc-diff" style="white-space:pre-wrap; max-height:36vh; overflow:auto;"></pre>
    </section>
  </div>
</div>

<script src="{{ url_for('static', filename='js/machine.js') }}"></script>
{% endblock %}
EOF2

# --- static/js/machine.js ---
cat <<'EOF2' > static/js/machine.js
(function(){
  const $ = (s, r=document) => r.querySelector(s);
  const tbody = $('#jobs-tbody');
  const detail = $('#job-detail');
  const logs = $('#job-logs');
  const title = $('#job-title');
  const btnCancel = $('#btn-cancel');

  let sel = null;
  let timer = null;

  function esc(s){ return (s==null?'':String(s)).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
  function fmtTs(t){ try{ return new Date(t*1000).toISOString().replace('T',' ').replace('Z',''); }catch(_){ return '—'; } }

  function rowHtml(r){
    return `<tr data-id="${esc(r.id)}" tabindex="0">
      <td><code>${esc(r.id)}</code></td>
      <td>${esc(r.type)}</td>
      <td><span class="cc-pill">${esc(r.status)}</span></td>
      <td>${esc(fmtTs(r.updated))}</td>
      <td><button class="cc-btn" data-open="${esc(r.id)}">Open</button></td>
    </tr>`;
  }

  async function listJobs(){
    const res = await fetch('/api/jobs');
    const j = await res.json();
    tbody.innerHTML = (j.jobs||[]).map(rowHtml).join('') || '<tr><td colspan="5">No jobs yet.</td></tr>';
  }

  async function openJob(id){
    sel = id;
    title.textContent = 'Details · ' + id;
    btnCancel.disabled = false;
    if(timer) clearInterval(timer);
    await refreshDetail();
    timer = setInterval(refreshDetail, 2000);
  }

  async function refreshDetail(){
    if(!sel) return;
    const [dres, lres] = await Promise.all([
      fetch('/api/jobs/'+sel),
      fetch('/api/jobs/'+sel+'/logs')
    ]);
    const d = await dres.json();
    const l = await lres.json();
    detail.innerHTML = `
      <div><strong>Status:</strong> ${esc(d.status)}</div>
      <div><strong>Type:</strong> ${esc(d.type)}</div>
      <div><strong>Artifacts:</strong> ${(d.artifacts||[]).map(a=>'<a class="cc-btn" href="/outputs/'+encodeURIComponent(a)+'" target="_blank">Open '+esc(a)+'</a>').join(' ') || '—'}</div>
      <div><strong>Result:</strong> <pre class="cc-diff" style="white-space:pre-wrap">${esc(JSON.stringify(d.result||{},null,2))}</pre></div>
    `;
    logs.textContent = (l.lines||[]).join('\n');
    if(l.eof && ['succeeded','failed','cancelled'].includes(d.status)) clearInterval(timer);
    listJobs(); // refresh table status
  }

  // Event wiring
  tbody.addEventListener('click', e=>{
    const id = e.target.getAttribute('data-open') || e.target.closest('tr')?.getAttribute('data-id');
    if(id) openJob(id);
  });
  tbody.addEventListener('keydown', e=>{
    if(e.key==='Enter' || e.key===' '){
      const tr = e.target.closest('tr'); if(tr){ openJob(tr.getAttribute('data-id')); e.preventDefault(); }
    }
  });

  btnCancel.addEventListener('click', async ()=>{
    if(!sel) return;
    await fetch('/api/jobs/'+sel+'/cancel', {method:'POST'});
    await refreshDetail();
  });

  // Demo enqueue buttons
  const demo = async (type, payload)=> {
    const r = await fetch('/api/jobs',{method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({type, payload})});
    const j = await r.json(); openJob(j.id);
  };
  document.getElementById('btn-demo-build').onclick = ()=> demo('build', {summary:'Hello world site', gen_tests:true, package_outputs:true});
  document.getElementById('btn-demo-fix').onclick = ()=> demo('fix', {error:'TypeError on click', snippet:'function x(){}', criteria:'no global leak'});
  document.getElementById('btn-demo-know').onclick = ()=> demo('know', {question:'What did PLAN.md say?'});

  listJobs();
})();
EOF2

# --- app.py (augment with job APIs + machine route) ---
cat <<'EOF2' > app.py
import os, json, time
from zipfile import ZipFile, ZIP_DEFLATED
from flask import Flask, render_template, request, jsonify, send_from_directory, session
from dotenv import load_dotenv

load_dotenv()

from services.orchestrator import BuildOrchestrator
from services.fixer import FixService
from services.knowledge import KnowledgeService
from services.jobs import JobQueue

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
jobs = JobQueue(worker_threads=int(os.getenv("JOBS_THREADS","3")))

# ---------- PAGES ----------
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

@app.route("/machine", methods=["GET"])
def machine():
    return render_template("machine.html")

@app.route("/healthz")
def healthz():
    return "ok", 200

# ---------- ARTIFACTS ----------
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

# ---------- BUILD (direct) ----------
@app.route("/api/build/plan", methods=["POST"])
def api_build_plan():
    summary = request.form.get("summary", "")
    gen_tests = request.form.get("gen_tests") in ("on","true","1")
    package  = request.form.get("package_outputs") in ("on","true","1")
    res = orchestrator.plan(summary, gen_tests, package)
    return jsonify(res.__dict__)

@app.route("/api/build/scaffold", methods=["POST"])
def api_build_scaffold():
    res = orchestrator.scaffold()
    return jsonify(res.__dict__)

@app.route("/api/build/tests", methods=["POST"])
def api_build_tests():
    res = orchestrator.tests()
    return jsonify(res.__dict__)

@app.route("/api/build/package", methods=["POST"])
def api_build_package():
    res = orchestrator.package()
    zip_path = os.path.join(app.config["OUTPUTS_DIR"], "build.zip")
    with ZipFile(zip_path, "w", ZIP_DEFLATED) as z:
        for fn in os.listdir(app.config["OUTPUTS_DIR"]):
            fp = os.path.join(app.config["OUTPUTS_DIR"], fn)
            if os.path.isfile(fp):
                z.write(fp, arcname=fn)
    return jsonify(res.__dict__)

# ---------- FIX (direct) ----------
@app.route("/api/fix", methods=["POST"])
def api_fix():
    error_text = request.form.get("error") or ""
    snippet    = request.form.get("snippet") or ""
    criteria   = request.form.get("criteria") or ""
    report = fixer.generate_fix(error_text, snippet, criteria)
    return jsonify({"diff": report.diff, "risk_notes": report.risk_notes})

@app.route("/api/fix/apply", methods=["POST"])
def api_fix_apply():
    diff_text = request.form.get("diff") or ""
    ok = bool(diff_text.strip())
    return jsonify({"applied": ok})

# ---------- KNOW (direct) ----------
@app.route("/api/know", methods=["POST"])
def api_know():
    q = request.form.get("question") or ""
    ans = knower.ask(q)
    return jsonify({"answer": ans.answer, "sources": ans.sources})

# ---------- JOB RUNNERS ----------
def _runner_build(job):
    s = job.payload or {}
    job.log.write("starting build plan")
    step = orchestrator.plan(s.get("summary",""), bool(s.get("gen_tests")), bool(s.get("package_outputs")))
    job.result["plan"] = step.log[-1]; job.artifacts += step.artifacts
    job.log.write("scaffold…"); step = orchestrator.scaffold()
    job.artifacts += step.artifacts
    if s.get("gen_tests"):
        job.log.write("tests…"); step = orchestrator.tests(); job.artifacts += step.artifacts
    if s.get("package_outputs"):
        job.log.write("package…"); step = orchestrator.package(); job.artifacts += step.artifacts
    job.log.write("done")

def _runner_fix(job):
    p = job.payload or {}
    job.log.write("generate diff…")
    rep = fixer.generate_fix(p.get("error",""), p.get("snippet",""), p.get("criteria",""))
    job.result = {"diff": rep.diff, "risk_notes": rep.risk_notes}
    job.log.write("done")

def _runner_know(job):
    p = job.payload or {}
    job.log.write("ask…")
    ans = knower.ask(p.get("question",""))
    job.result = {"answer": ans.answer, "sources": ans.sources}
    job.log.write("done")

_RUNNERS = {"build": _runner_build, "fix": _runner_fix, "know": _runner_know}

# ---------- JOB API ----------
@app.route("/api/jobs", methods=["POST"])
def api_jobs_create():
    data = request.get_json(force=True, silent=True) or {}
    jtype = data.get("type"); payload = data.get("payload") or {}
    if jtype not in _RUNNERS: return jsonify({"error":"invalid type"}), 400
    job = jobs.enqueue(jtype, payload, _RUNNERS[jtype])
    return jsonify({"id": job.id})

@app.route("/api/jobs", methods=["GET"])
def api_jobs_list():
    return jsonify({"jobs": jobs.list()})

@app.route("/api/jobs/<jid>", methods=["GET"])
def api_jobs_get(jid):
    j = jobs.get(jid); 
    if not j: return jsonify({"error":"not found"}), 404
    return jsonify(j.to_detail())

@app.route("/api/jobs/<jid>/logs", methods=["GET"])
def api_jobs_logs(jid):
    j = jobs.get(jid); 
    if not j: return jsonify({"error":"not found"}), 404
    lines, eof = j.log.read()
    return jsonify({"lines": lines, "eof": eof})

@app.route("/api/jobs/<jid>/cancel", methods=["POST"])
def api_jobs_cancel(jid):
    return jsonify({"cancelled": jobs.cancel(jid)})

if __name__ == "__main__":
    port = int(os.getenv("PORT","5000"))
    app.run(host="0.0.0.0", port=port, debug=True)
EOF2

echo "Jobs v1 + Machine Room v1 applied."
echo "Next:"
echo "  1) pip install -r requirements.txt  # none new needed"
echo "  2) python app.py   # then open /machine"
echo "  3) On Render, your existing Procfile/start command works unchanged."
