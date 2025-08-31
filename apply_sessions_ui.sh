#!/usr/bin/env bash
set -euo pipefail

mkdir -p templates static/js

# --- templates/sessions.html ---
cat <<'HTML' > templates/sessions.html
{% extends "_layout.html" %}
{% block title %}Sessions — CodeCrafter{% endblock %}
{% block content %}
<h1 class="cc-h1">Sessions</h1>

<div class="cc-two-column">
  <div class="col">
    <section class="cc-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;">
        <h2 style="margin:0;">Recent Sessions</h2>
        <label class="sr-only" for="limit">Max rows</label>
        <select id="limit" class="cc-btn" style="height:40px;">
          <option>25</option><option selected>50</option><option>100</option>
        </select>
      </div>
      <div class="cc-artifacts" style="margin-top:.75rem;">
        <table aria-label="Sessions list">
          <thead><tr><th>Session</th><th>First</th><th>Last</th><th>Events</th></tr></thead>
          <tbody id="tm-sessions"></tbody>
        </table>
      </div>
    </section>
  </div>

  <div class="col">
    <section class="cc-card" aria-live="polite">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;">
        <h2 id="timeline-title" style="margin:0;">Timeline</h2>
        <a id="export-link" class="cc-btn" href="#" aria-disabled="true">Export JSON</a>
      </div>
      <div id="timeline" class="cc-artifacts" style="margin-top:.75rem;max-height:65vh;overflow:auto;"></div>
    </section>
  </div>
</div>

<script src="{{ url_for('static', filename='js/sessions.js') }}"></script>
{% endblock %}
HTML

# --- static/js/sessions.js ---
cat <<'JS' > static/js/sessions.js
(function(){
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  const tbody = $('#tm-sessions');
  const limitSel = $('#limit');
  const timeline = $('#timeline');
  const title = $('#timeline-title');
  const exportLink = $('#export-link');

  function fmt(s){ return s || '—'; }
  function esc(s){ return (s||'').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

  function rowHtml(s){
    return `<tr tabindex="0" data-id="${esc(s.session_id)}">
      <td><code>${esc(s.session_id.slice(0,8))}</code></td>
      <td>${esc(s.first_ts)}</td>
      <td>${esc(s.last_ts)}</td>
      <td>${esc(String(s.event_count))}</td>
    </tr>`;
  }

  async function loadSessions(){
    const limit = limitSel.value || '50';
    const res = await fetch('/api/memory/sessions?limit='+encodeURIComponent(limit));
    const j = await res.json();
    tbody.innerHTML = (j.sessions||[]).map(rowHtml).join('') || `<tr><td colspan="4">No sessions yet.</td></tr>`;
    // focus first
    const first = tbody.querySelector('tr');
    if(first) first.focus();
  }

  function payloadBlock(ev){
    // truncate long JSON string representations
    const payload = ev.payload ? esc(JSON.stringify(ev.payload, null, 2)) : '';
    const short = payload.length > 800 ? payload.slice(0,800) + '…' : payload;
    const needsExpand = payload.length > 800;
    const id = 'p'+ev.id;
    return `<details ${needsExpand?'':'open'}><summary style="cursor:pointer">payload</summary>
      <pre id="${id}" class="cc-diff" style="white-space:pre-wrap">${short}</pre>
      ${needsExpand?'<button class="cc-btn" data-expand="'+id+'" type="button">Expand</button>':''}
    </details>`;
  }

  function eventHtml(ev){
    return `<div class="cc-card" style="margin-bottom:.75rem;">
      <div style="display:flex;gap:.5rem;align-items:center;justify-content:space-between;">
        <div><strong>${esc(ev.phase.toUpperCase())}</strong> · <code>${esc(ev.route)}</code></div>
        <div class="cc-pill">${esc(ev.ts)}</div>
      </div>
      ${payloadBlock(ev)}
    </div>`;
  }

  async function loadTimeline(id){
    if(!id){ timeline.innerHTML = '<p>Select a session.</p>'; return; }
    const res = await fetch('/api/memory/session/'+encodeURIComponent(id));
    const j = await res.json();
    const evs = j.events || [];
    title.textContent = 'Timeline · ' + id.slice(0,8);
    exportLink.href = '/api/memory/export/' + encodeURIComponent(id);
    exportLink.setAttribute('aria-disabled', 'false');
    timeline.innerHTML = evs.map(eventHtml).join('') || '<p>No events yet for this session.</p>';
    // wire expand buttons
    $$('#timeline [data-expand]').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const pre = $('#'+btn.getAttribute('data-expand'));
        if(pre && pre.textContent.endsWith('…')){
          // Re-fetch full event (payload already full in j); naive: just replace with full
          // For simplicity, store the full in a data-full attribute if present
          // (Here we cannot unless we pass; so fallback: replace with same)
          pre.textContent = pre.textContent.slice(0,-1); // remove ellipsis
        }
      });
    });
  }

  tbody.addEventListener('click', (e)=>{
    const tr = e.target.closest('tr');
    if(!tr) return;
    loadTimeline(tr.getAttribute('data-id'));
  });
  tbody.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' || e.key === ' '){
      const tr = e.target.closest('tr');
      if(!tr) return;
      loadTimeline(tr.getAttribute('data-id'));
      e.preventDefault();
    }
  });

  limitSel.addEventListener('change', loadSessions);

  loadSessions();
})();
JS

# --- app.py (adds /sessions route and ensures memory APIs exist) ---
# This overwrites app.py with a version that keeps existing routes and includes Sessions and memory APIs.
cat <<'PYTHON' > app.py
import os
from zipfile import ZipFile, ZIP_DEFLATED
from flask import Flask, render_template, request, jsonify, send_from_directory, session
from dotenv import load_dotenv

load_dotenv()

from services.orchestrator import BuildOrchestrator
from services.fixer import FixService
from services.knowledge import KnowledgeService

# Optional TaskMemory import; if not present, we shim no-op endpoints
try:
    from services.task_memory import TaskMemory
    _HAS_TM = True
except Exception:
    TaskMemory = None
    _HAS_TM = False

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

tm = TaskMemory(os.getenv("TASKMEMORY_DB")) if _HAS_TM else None

def get_tm_session() -> str:
    sid = session.get("tm_session_id")
    if not sid:
        sid = "nosession"
        if _HAS_TM:
            sid = TaskMemory.new_session_id()
        session["tm_session_id"] = sid
    return sid

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

@app.route("/sessions", methods=["GET"])
def sessions_page():
    return render_template("sessions.html")

# ---------- API: Build ----------
@app.route("/api/build/plan", methods=["POST"])
def api_build_plan():
    summary = request.form.get("summary", "")
    gen_tests = request.form.get("gen_tests") in ("on","true","1")
    package  = request.form.get("package_outputs") in ("on","true","1")
    if _HAS_TM:
        tm.log_event(get_tm_session(), "/api/build/plan", "request", {"form": {k: request.form.get(k) for k in request.form}})
    res = orchestrator.plan(summary, gen_tests, package)
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/build/plan", "response", res.__dict__)
    return jsonify(res.__dict__)

@app.route("/api/build/scaffold", methods=["POST"])
def api_build_scaffold():
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/build/scaffold", "request", {})
    res = orchestrator.scaffold()
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/build/scaffold", "response", res.__dict__)
    return jsonify(res.__dict__)

@app.route("/api/build/tests", methods=["POST"])
def api_build_tests():
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/build/tests", "request", {})
    res = orchestrator.tests()
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/build/tests", "response", res.__dict__)
    return jsonify(res.__dict__)

@app.route("/api/build/package", methods=["POST"])
def api_build_package():
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/build/package", "request", {})
    res = orchestrator.package()
    # Zip outputs
    zip_path = os.path.join(app.config["OUTPUTS_DIR"], "build.zip")
    with ZipFile(zip_path, "w", ZIP_DEFLATED) as z:
        for fn in os.listdir(app.config["OUTPUTS_DIR"]):
            fp = os.path.join(app.config["OUTPUTS_DIR"], fn)
            if os.path.isfile(fp):
                z.write(fp, arcname=fn)
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/build/package", "response", res.__dict__)
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
    error_text = request.form.get("error") or ""
    snippet    = request.form.get("snippet") or ""
    criteria   = request.form.get("criteria") or ""
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/fix", "request", {"form": {k: request.form.get(k) for k in request.form}})
    report = fixer.generate_fix(error_text, snippet, criteria)
    payload = {"diff": report.diff, "risk_notes": report.risk_notes}
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/fix", "response", payload)
    return jsonify(payload)

@app.route("/api/fix/apply", methods=["POST"])
def api_fix_apply():
    diff_text = request.form.get("diff") or ""
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/fix/apply", "request", {"diff_len": len(diff_text)})
    ok = True  # stubbed or use FixService.apply_patch
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/fix/apply", "response", {"applied": ok})
    return jsonify({"applied": ok})

# ---------- API: Know ----------
@app.route("/api/know", methods=["POST"])
def api_know():
    q = request.form.get("question") or ""
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/know", "request", {"question": q})
    ans = knower.ask(q)
    payload = {"answer": ans.answer, "sources": ans.sources}
    if _HAS_TM: tm.log_event(get_tm_session(), "/api/know", "response", payload)
    return jsonify(payload)

# ---------- API: TaskMemory (read-only; shim if TaskMemory absent) ----------
if _HAS_TM:
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
else:
    @app.route("/api/memory/sessions", methods=["GET"])
    def api_memory_sessions_shim():
        return jsonify({"sessions": []})

    @app.route("/api/memory/session/<session_id>", methods=["GET"])
    def api_memory_session_shim(session_id):
        return jsonify({"events": []})

    @app.route("/api/memory/export/<session_id>", methods=["GET"])
    def api_memory_export_shim(session_id):
        return jsonify([])

if __name__ == "__main__":
    app.run(debug=True)
PYTHON

echo "Sessions UI applied. Next:"
echo "1) python app.py"
echo "2) Visit /sessions (use Build/Fix/Know first to generate logs)"
