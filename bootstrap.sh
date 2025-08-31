#!/usr/bin/env bash
set -euo pipefail

mkdir -p services templates static/css static/js uploads outputs

# .gitignore
cat <<'EOF' > .gitignore
__pycache__/
*.pyc
.venv/
venv/
.env
.DS_Store
Thumbs.db
.vscode/
uploads/*
outputs/*
!uploads/.gitkeep
!outputs/.gitkeep
EOF

# touch gitkeeps
touch uploads/.gitkeep outputs/.gitkeep

# requirements.txt
cat <<'EOF' > requirements.txt
Flask>=3.0.0
EOF

# README.md
cat <<'EOF' > README.md
# Code_Crafter2

Clean Apple-style UI (dark + green) with Build/Fix/Know flows on Flask.
- Install: `pip install -r requirements.txt`
- Run: `python app.py` then open http://localhost:5000

Swap stubs with your AI tooling in `services/`.
EOF

# services/orchestrator.py
cat <<'EOF' > services/orchestrator.py
from dataclasses import dataclass, field
from typing import List

@dataclass
class StepResult:
    name: str
    status: str  # idle|running|done|error
    log: List[str] = field(default_factory=list)
    artifacts: List[str] = field(default_factory=list)

class BuildOrchestrator:
    def __init__(self, outputs_dir="outputs"):
        self.outputs_dir = outputs_dir

    def plan(self, summary: str, generate_tests: bool, package_outputs: bool) -> StepResult:
        logs = [
            "Gathering requirements…",
            f"Summary: {summary[:140]}",
            f"generate_tests={generate_tests} package_outputs={package_outputs}",
            "Producing PLAN.md…"
        ]
        return StepResult(name="Plan", status="done", log=logs, artifacts=["PLAN.md"])

    def scaffold(self) -> StepResult:
        logs = ["Scaffolding project…", "Created index.html, style.css, script.js"]
        artifacts = ["index.html", "style.css", "script.js"]
        return StepResult(name="Scaffolding", status="done", log=logs, artifacts=artifacts)

    def tests(self) -> StepResult:
        logs = ["Generating tests…", "Running tests…", "All tests passed"]
        return StepResult(name="Tests", status="done", log=logs, artifacts=["TEST_REPORT.txt"])

    def package(self) -> StepResult:
        logs = ["Bundling artifacts…", "Created BUILD_REPORT.json and build.zip"]
        return StepResult(name="Package", status="done", log=logs, artifacts=["BUILD_REPORT.json","build.zip"])
EOF

# services/fixer.py
cat <<'EOF' > services/fixer.py
from dataclasses import dataclass
from typing import Optional

@dataclass
class FixReport:
    diff: str
    risk_notes: str

class FixService:
    def generate_fix(self, error_text: str, snippet: Optional[str], criteria: Optional[str]) -> FixReport:
        sample_before = snippet or "def teh_func():\n    pass\n"
        sample_after  = sample_before.replace("teh", "the")
        diff = (
            "--- a/code.py\n"
            "+++ b/code.py\n"
            "@@ -1,2 +1,2 @@\n"
            "-def teh_func():\n"
            "+def the_func():\n"
            "     pass\n"
        )
        risks = "- Low risk rename refactor\n- Verify call sites for symbol changes"
        return FixReport(diff=diff, risk_notes=risks)

    def apply_patch(self, diff_text: str) -> bool:
        return True
EOF

# services/knowledge.py
cat <<'EOF' > services/knowledge.py
from dataclasses import dataclass
from typing import List

@dataclass
class QAResult:
    answer: str
    sources: List[str]

class KnowledgeService:
    def ask(self, question: str) -> QAResult:
        return QAResult(
            answer=f"Planned steps for: {question}",
            sources=["docs/PLAN.md", "tests/TEST_REPORT.txt"]
        )
EOF

# app.py
cat <<'EOF' > app.py
import os
from zipfile import ZipFile, ZIP_DEFLATED
from flask import Flask, render_template, request, jsonify, send_from_directory
from services.orchestrator import BuildOrchestrator
from services.fixer import FixService
from services.knowledge import KnowledgeService

app = Flask(__name__)
BASE_DIR = os.path.dirname(__file__)
app.config["UPLOAD_FOLDER"] = os.path.join(BASE_DIR, "uploads")
app.config["OUTPUTS_DIR"]  = os.path.join(BASE_DIR, "outputs")
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["OUTPUTS_DIR"], exist_ok=True)

orchestrator = BuildOrchestrator(outputs_dir=app.config["OUTPUTS_DIR"])
fixer = FixService()
knower = KnowledgeService()

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
    summary = request.form.get("summary", "")
    gen_tests = request.form.get("gen_tests") in ("on","true","1")
    package  = request.form.get("package_outputs") in ("on","true","1")
    res = orchestrator.plan(summary, gen_tests, package)
    return jsonify(res.__dict__)

@app.route("/api/build/scaffold", methods=["POST"])
def api_build_scaffold():
    res = orchestrator.scaffold()
    out = app.config["OUTPUTS_DIR"]
    with open(os.path.join(out, "index.html"), "w") as f:
        f.write("<!doctype html><meta charset='utf-8'><title>Hello</title><h1>Hello CodeCrafter</h1>")
    with open(os.path.join(out, "style.css"), "w") as f:
        f.write("body{font-family:system-ui}")
    with open(os.path.join(out, "script.js"), "w") as f:
        f.write("console.log('ok');")
    return jsonify(res.__dict__)

@app.route("/api/build/tests", methods=["POST"])
def api_build_tests():
    res = orchestrator.tests()
    with open(os.path.join(app.config["OUTPUTS_DIR"], "TEST_REPORT.txt"), "w") as f:
        f.write("All tests passed.\n")
    return jsonify(res.__dict__)

@app.route("/api/build/package", methods=["POST"])
def api_build_package():
    res = orchestrator.package()
    out = app.config["OUTPUTS_DIR"]
    with open(os.path.join(out, "BUILD_REPORT.json"), "w") as f:
        f.write('{"status":"ok","artifacts":["index.html","style.css","script.js"]}')
    zip_path = os.path.join(out, "build.zip")
    with ZipFile(zip_path, "w", ZIP_DEFLATED) as z:
        for fname in ["index.html","style.css","script.js","TEST_REPORT.txt","BUILD_REPORT.json"]:
            fpath = os.path.join(out, fname)
            if os.path.exists(fpath):
                z.write(fpath, arcname=fname)
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
    report = fixer.generate_fix(error_text, snippet, criteria)
    return jsonify({"diff": report.diff, "risk_notes": report.risk_notes})

@app.route("/api/fix/apply", methods=["POST"])
def api_fix_apply():
    diff_text = request.form.get("diff") or ""
    ok = fixer.apply_patch(diff_text)
    return jsonify({"applied": ok})

# ---------- API: Know ----------
@app.route("/api/know", methods=["POST"])
def api_know():
    q = request.form.get("question") or ""
    ans = knower.ask(q)
    return jsonify({"answer": ans.answer, "sources": ans.sources})

if __name__ == "__main__":
    app.run(debug=True)
EOF

# templates/_layout.html
cat <<'EOF' > templates/_layout.html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>{% block title %}CodeCrafter{% endblock %}</title>
  <link rel="stylesheet" href="{{ url_for('static', filename='css/cc-ui.css') }}">
</head>
<body class="cc-bg">
  <a class="sr-only" href="#main">Skip to content</a>
  <header class="cc-toolbar" role="banner">
    <div class="cc-toolbar__left">
      <span class="cc-app-icon" aria-hidden="true"></span>
      <span class="cc-app-name">CodeCrafter</span>
    </div>
    <button class="cc-toolbar__toggle" aria-expanded="false" aria-controls="nav">Menu</button>
    <nav id="nav" class="cc-toolbar__nav" aria-label="Primary">
      <a class="cc-nav-link" href="{{ url_for('build') }}">Build</a>
      <a class="cc-nav-link" href="{{ url_for('fix') }}">Fix</a>
      <a class="cc-nav-link" href="{{ url_for('know') }}">Know</a>
      <span class="cc-nav-link cc-nav-link--disabled" aria-disabled="true">Machine Room</span>
      <span class="cc-nav-link cc-nav-link--disabled" aria-disabled="true">Jobs</span>
      <span class="cc-nav-link cc-nav-link--disabled" aria-disabled="true">Settings</span>
    </nav>
    <div class="cc-toolbar__right" aria-live="polite">
      {% if job %}<span class="cc-pill cc-pill--running">Job: {{ job.id }}</span>{% endif %}
    </div>
  </header>

  <main id="main" class="cc-container" tabindex="-1">
    {% block content %}{% endblock %}
  </main>

  <footer class="cc-footer">
    <small>&copy; CodeCrafter</small>
  </footer>

  <div id="toast-container" class="cc-toast-container" aria-live="polite"></div>
  <script src="{{ url_for('static', filename='js/cc-ui.js') }}"></script>
</body>
</html>
EOF

# templates/home.html
cat <<'EOF' > templates/home.html
{% extends "_layout.html" %}
{% block title %}Home — CodeCrafter{% endblock %}
{% block content %}
<h1 class="cc-h1">Welcome</h1>
<div class="cc-grid cc-grid-3">
  <div class="cc-card">
    <div class="cc-card-icon" aria-hidden="true">🧱</div>
    <h2>Build</h2>
    <p>Plan → Scaffold → Test → Package</p>
    <div class="cc-card-actions">
      <a href="{{ url_for('build') }}" class="cc-btn cc-btn--primary">Start</a>
    </div>
  </div>
  <div class="cc-card">
    <div class="cc-card-icon" aria-hidden="true">🩹</div>
    <h2>Fix</h2>
    <p>Submit error & snippet, get a patch</p>
    <div class="cc-card-actions">
      <a href="{{ url_for('fix') }}" class="cc-btn cc-btn--primary">Start</a>
    </div>
  </div>
  <div class="cc-card">
    <div class="cc-card-icon" aria-hidden="true">🔎</div>
    <h2>Know</h2>
    <p>Ask questions, get sourced answers</p>
    <div class="cc-card-actions">
      <a href="{{ url_for('know') }}" class="cc-btn cc-btn--primary">Start</a>
    </div>
  </div>
</div>
{% endblock %}
EOF

# templates/build.html
cat <<'EOF' > templates/build.html
{% extends "_layout.html" %}
{% block title %}Build — CodeCrafter{% endblock %}
{% block content %}
<h1 class="cc-h1">Build</h1>
<div class="cc-two-column">
  <div class="col">
    <form method="post" enctype="multipart/form-data">
      <label for="summary">Summary</label>
      <textarea id="summary" name="summary" rows="6" placeholder="Describe what to build…"></textarea>

      <div style="display:flex;gap:1rem;align-items:center;margin:.5rem 0 1rem;">
        <label><input type="checkbox" name="gen_tests"> Generate tests</label>
        <label><input type="checkbox" name="package_outputs"> Package to /outputs</label>
      </div>

      <label for="file">Optional file (zip/patch)</label>
      <input id="file" type="file" name="file">
    </form>

    <div class="cc-card" style="margin-top:1rem;">
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
        <button class="cc-btn cc-btn--primary" type="button" data-action="plan">Plan</button>
        <button class="cc-btn" type="button" data-action="scaffold">Scaffolding</button>
        <button class="cc-btn" type="button" data-action="tests">Tests</button>
        <button class="cc-btn" type="button" data-action="package">Package</button>
      </div>
    </div>
  </div>
  <div class="col">
    <section class="cc-card">
      <h2>Artifacts</h2>
      <div class="cc-artifacts">
        <table>
          <thead><tr><th>File</th><th>Size</th></tr></thead>
          <tbody id="artifacts-tbody"></tbody>
        </table>
      </div>
    </section>
  </div>
</div>

<script>
async function call(endpoint, formData){
  const res = await fetch(endpoint, { method: 'POST', body: formData });
  return res.json();
}
function refreshArtifacts(){
  fetch('/api/artifacts').then(r=>r.json()).then(data=>{
    const tbody = document.querySelector('#artifacts-tbody');
    if(!tbody) return;
    tbody.innerHTML = data.files.map(f=>
      `<tr><td><a href="/outputs/${f.name}" target="_blank">${f.name}</a></td><td>${f.size}</td></tr>`
    ).join('');
  });
}
document.querySelectorAll('[data-action]').forEach(btn=>{
  btn.addEventListener('click', async ()=>{
    const action = btn.getAttribute('data-action');
    const form = document.querySelector('form');
    const fd = new FormData(form);
    const map = {
      plan:'/api/build/plan',
      scaffold:'/api/build/scaffold',
      tests:'/api/build/tests',
      package:'/api/build/package'
    };
    if(!map[action]) return;
    const out = await call(map[action], fd);
    if(window.Toast) Toast.show('info', `${action}: ${out.status}`);
    refreshArtifacts();
  });
});
refreshArtifacts();
</script>
{% endblock %}
EOF

# templates/fix.html
cat <<'EOF' > templates/fix.html
{% extends "_layout.html" %}
{% block title %}Fix — CodeCrafter{% endblock %}
{% block content %}
<h1 class="cc-h1">Fix</h1>
<div class="cc-two-column">
  <div class="col">
    <form method="post" enctype="multipart/form-data">
      <label for="error">Error</label>
      <textarea id="error" name="error" rows="4" placeholder="Paste error logs…"></textarea>

      <label for="snippet">Code snippet (optional)</label>
      <textarea id="snippet" name="snippet" rows="6" placeholder="Paste the relevant code…"></textarea>

      <label for="criteria">Acceptance criteria (optional)</label>
      <textarea id="criteria" name="criteria" rows="4" placeholder="Define what 'good' looks like…"></textarea>
    </form>
    <div style="display:flex;gap:.5rem;margin-top:.5rem;">
      <button id="gen-fix" class="cc-btn cc-btn--primary" type="button">Generate Fix</button>
      <button id="apply-fix" class="cc-btn" type="button">Apply Patch</button>
    </div>
    <p><a class="cc-nav-link cc-nav-link--disabled" aria-disabled="true">Open in Machine Room</a></p>
  </div>

  <div class="col">
    <section class="cc-card">
      <h2>Fix Report</h2>
      <pre class="cc-diff" id="fix-diff" aria-label="Unified diff output"></pre>
      <h3>Risk Notes</h3>
      <pre id="fix-risk"></pre>
    </section>
  </div>
</div>

<script>
document.getElementById('gen-fix').addEventListener('click', async ()=>{
  const fd = new FormData(document.querySelector('form'));
  const r = await fetch('/api/fix', { method:'POST', body:fd });
  const j = await r.json();
  document.getElementById('fix-diff').textContent = j.diff;
  document.getElementById('fix-risk').textContent = j.risk_notes;
});
document.getElementById('apply-fix').addEventListener('click', async ()=>{
  const diff = document.getElementById('fix-diff').textContent;
  const fd = new FormData(); fd.append('diff', diff);
  const r = await fetch('/api/fix/apply', { method:'POST', body:fd });
  const j = await r.json();
  if(window.Toast) Toast.show(j.applied ? 'success':'error', j.applied ? 'Patch applied' : 'Patch failed');
});
</script>
{% endblock %}
EOF

# templates/know.html
cat <<'EOF' > templates/know.html
{% extends "_layout.html" %}
{% block title %}Know — CodeCrafter{% endblock %}
{% block content %}
<h1 class="cc-h1">Know</h1>
<form method="post">
  <label for="question">Question</label>
  <textarea id="question" name="question" rows="4" placeholder="Ask something about the project…"></textarea>
  <div style="margin-top:.5rem;">
    <button id="ask-btn" class="cc-btn cc-btn--primary" type="button">Ask</button>
  </div>
</form>

<div class="cc-card" style="margin-top:1.5rem;">
  <h2>Answer</h2>
  <div id="answer-body" class="cc-body">(answer appears here)</div>
  <h3>Sources</h3>
  <ul id="answer-sources"></ul>
</div>

<script>
document.getElementById('ask-btn').addEventListener('click', async ()=>{
  const fd = new FormData(document.querySelector('form'));
  const r = await fetch('/api/know', { method:'POST', body:fd });
  const j = await r.json();
  document.getElementById('answer-body').textContent = j.answer;
  document.getElementById('answer-sources').innerHTML = j.sources.map(s=>`<li>${s}</li>`).join('');
});
</script>
{% endblock %}
EOF

# static/css/cc-ui.css
cat <<'EOF' > static/css/cc-ui.css
:root{
  --bg:#0c0d10; --surface:#111317; --elev:#16191f;
  --text:#e8eaf0; --muted:#a8b0bf; --line:#242833;
  --accent:#4ade80; --accent-ink:#06381d;
  --danger:#ef4444; --danger-ink:#3b0a0a; --warning:#fde047; --warning-ink:#3b2f07;
  --radius:14px; --shadow:0 8px 24px rgba(0,0,0,.25);
  --pad:clamp(12px,2.2vw,20px);
  --focus: 0 0 0 2px rgba(74,222,128,.8);
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif}

/* A11y */
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
:focus{outline:none} :focus-visible{box-shadow:var(--focus);border-radius:8px}

/* Layout */
.cc-container{max-width:1100px;margin:0 auto;padding:var(--pad)}
.cc-footer{padding:var(--pad);color:var(--muted);border-top:1px solid var(--line)}

/* Toolbar */
.cc-toolbar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:1rem;padding:var(--pad);background:var(--surface);border-bottom:1px solid var(--line)}
.cc-app-icon{width:12px;height:12px;border-radius:4px;background:var(--accent);display:inline-block;margin-right:.5rem}
.cc-app-name{font-weight:600}
.cc-toolbar__nav{display:flex;gap:1rem}
.cc-toolbar__toggle{display:none}
.cc-toolbar__right{margin-left:auto}
.cc-nav-link{color:var(--text);opacity:.9;text-decoration:none}
.cc-nav-link:hover,.cc-nav-link:focus{opacity:1;text-decoration:underline}
.cc-nav-link--disabled{opacity:.4;pointer-events:none}

/* Responsive nav */
@media (max-width:768px){
  .cc-toolbar{flex-wrap:wrap}
  .cc-toolbar__toggle{display:inline-flex;padding:.5rem .75rem;border:1px solid var(--line);background:transparent;color:var(--text);border-radius:10px}
  .cc-toolbar__nav{display:none;width:100%}
  .cc-toolbar__nav.open{display:flex;flex-direction:column}
}

/* Cards / Buttons / Pills */
.cc-card{background:var(--elev);border:1px solid var(--line);border-radius:var(--radius);padding:var(--pad);box-shadow:var(--shadow)}
.cc-card-icon{font-size:28px}
.cc-card-actions{margin-top:.5rem}
.cc-btn{height:44px;min-width:44px;padding:.5rem 1rem;border-radius:12px;border:1px solid var(--line);background:transparent;color:var(--text);cursor:pointer}
.cc-btn:focus-visible{box-shadow:var(--focus)}
.cc-btn--primary{background:var(--accent);color:var(--accent-ink);border-color:transparent}
.cc-pill{display:inline-flex;align-items:center;height:28px;padding:0 .6rem;border-radius:999px;background:var(--line);color:var(--muted);}

/* Grid/Columns */
.cc-grid{display:grid;gap:var(--pad)}
.cc-grid-3{grid-template-columns:repeat(1,1fr)}
@media(min-width:900px){.cc-grid-3{grid-template-columns:repeat(3,1fr)}}
.cc-two-column{display:flex;flex-direction:column;gap:var(--pad)}
@media(min-width:900px){.cc-two-column{flex-direction:row}.cc-two-column>.col{flex:1}}

/* Forms */
label{display:block;margin:.5rem 0 .25rem;color:var(--muted)}
input[type="text"],input[type="file"],textarea{width:100%;background:var(--surface);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:.6rem}
textarea{resize:vertical}

/* Artifacts */
.cc-artifacts table{width:100%;border-collapse:collapse}
.cc-artifacts th,.cc-artifacts td{border-bottom:1px solid var(--line);padding:.5rem;text-align:left}

/* Diff */
.cc-diff{background:#0b0c0f;border:1px solid var(--line);border-radius:12px;padding:12px;overflow:auto}
.cc-diff .add{background-color:rgba(74,222,128,.18)}
.cc-diff .del{background-color:rgba(239,68,68,.18)}
.cc-diff .ctx{color:var(--muted)}

/* Toasts */
.cc-toast-container{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px}
.cc-toast{padding:.6rem .8rem;border-radius:10px;border:1px solid var(--line);background:var(--elev)}
.cc-toast--success{background:rgba(74,222,128,.15)}
.cc-toast--error{background:rgba(239,68,68,.15)}
.cc-toast--info{background:rgba(255,255,255,.06)}

/* Reduced motion */
@media (prefers-reduced-motion: reduce){
  *{transition:none !important; animation:none !important}
}
EOF

# static/js/cc-ui.js
cat <<'EOF' > static/js/cc-ui.js
(function(){
  // Toasts
  window.Toast = {
    show(type, msg){
      const wrap = document.getElementById('toast-container');
      if(!wrap) return;
      const t = document.createElement('div');
      t.className = `cc-toast cc-toast--${type}`;
      t.textContent = msg;
      wrap.appendChild(t);
      setTimeout(()=> t.remove(), 5000);
    }
  };

  // Responsive nav
  const toggle = document.querySelector('.cc-toolbar__toggle');
  const nav = document.querySelector('.cc-toolbar__nav');
  if(toggle && nav){
    toggle.addEventListener('click', ()=>{
      const open = nav.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true':'false');
    });
  }
})();
EOF

chmod +x bootstrap.sh
echo "Created Code_Crafter2 scaffold. Run:  ./bootstrap.sh  &&  pip install -r requirements.txt  &&  python app.py"
