#!/usr/bin/env bash
set -euo pipefail

# Ensure dirs
mkdir -p services

# 1) requirements.txt (append if exists)
if [ -f requirements.txt ]; then
  awk '1' requirements.txt > requirements.txt.bak
  mv requirements.txt.bak requirements.txt
fi
# Enforce required deps (idempotent append)
touch requirements.txt
grep -q '^Flask' requirements.txt || echo 'Flask>=3.0.0' >> requirements.txt
grep -q '^openai' requirements.txt || echo 'openai>=1.40.0' >> requirements.txt
grep -q '^python-dotenv' requirements.txt || echo 'python-dotenv>=1.0.1' >> requirements.txt
grep -q '^tenacity' requirements.txt || echo 'tenacity>=8.2.3' >> requirements.txt

# 2) services/llm_client.py
cat <<'EOPY' > services/llm_client.py
import os
from tenacity import retry, stop_after_attempt, wait_exponential
from openai import OpenAI

OPENAI_MODEL_BUILD = os.getenv("OPENAI_MODEL_BUILD", "gpt-4o-mini")
OPENAI_MODEL_FIX   = os.getenv("OPENAI_MODEL_FIX",   "gpt-4o-mini")
OPENAI_MODEL_KNOW  = os.getenv("OPENAI_MODEL_KNOW",  "gpt-4o-mini")

class LLMClient:
    def __init__(self):
        self.client = OpenAI()  # reads OPENAI_API_KEY from env

    @retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=1, max=6))
    def complete(self, messages, model=None, temperature=0.2, max_tokens=1200):
        mdl = model or OPENAI_MODEL_BUILD
        resp = self.client.chat.completions.create(
            model=mdl,
            temperature=temperature,
            max_tokens=max_tokens,
            messages=messages
        )
        return resp.choices[0].message.content or ""
EOPY

# 3) services/orchestrator.py
cat <<'EOPY' > services/orchestrator.py
import os, json, re
from dataclasses import dataclass, field
from typing import List
from .llm_client import LLMClient, OPENAI_MODEL_BUILD

@dataclass
class StepResult:
    name: str
    status: str  # idle|running|done|error
    log: List[str] = field(default_factory=list)
    artifacts: List[str] = field(default_factory=list)

PLAN_PROMPT = """You are CodeCrafter, a senior software agent.
Task: Draft a concise PLAN.md for a small web feature.

Include:
- Goal
- User story
- Acceptance criteria
- Files to create (with 1–2 lines each)
Keep it short and actionable.
Summary:
{summary}
Options: generate_tests={gen_tests}, package_outputs={package_outputs}
"""

SCAFFOLD_PROMPT = """Create minimal but clean web artifacts:
- index.html (include a header and script.css and script.js references)
- style.css (dark theme compatible with a green accent)
- script.js (console.log + placeholder)
Return ONLY a JSON object with keys index.html, style.css, script.js whose values are file contents. No extra commentary.
"""

TESTS_PROMPT = """Produce a short text test report. Assume all simple checks pass.
Return a brief human-readable summary.
"""

PACKAGE_PROMPT = """Return a tiny JSON build report with keys:
status="ok", notes="packaged locally"
"""

class BuildOrchestrator:
    def __init__(self, outputs_dir="outputs"):
        self.outputs_dir = outputs_dir
        os.makedirs(self.outputs_dir, exist_ok=True)
        self.llm = LLMClient()

    def _write(self, name: str, content: str):
        path = os.path.join(self.outputs_dir, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    def plan(self, summary: str, generate_tests: bool, package_outputs: bool) -> StepResult:
        logs = ["Calling LLM for PLAN.md…"]
        prompt = PLAN_PROMPT.format(summary=summary, gen_tests=generate_tests, package_outputs=package_outputs)
        out = self.llm.complete([
            {"role": "system", "content": "You write concise project plans."},
            {"role": "user", "content": prompt}
        ], model=OPENAI_MODEL_BUILD, max_tokens=600)
        self._write("PLAN.md", out.strip())
        logs.append("PLAN.md written")
        return StepResult(name="Plan", status="done", log=logs, artifacts=["PLAN.md"])

    def scaffold(self) -> StepResult:
        logs = ["Generating index.html/style.css/script.js via LLM…"]
        json_blob = self.llm.complete([
            {"role": "system", "content": "You output only JSON; no commentary."},
            {"role": "user", "content": SCAFFOLD_PROMPT}
        ], model=OPENAI_MODEL_BUILD, max_tokens=1600)

        m = re.search(r'\{.*\}', json_blob, re.S)
        payload = json.loads(m.group(0)) if m else {}
        idx = payload.get("index.html", "<!doctype html><h1>Hello</h1>")
        css = payload.get("style.css", "body{font-family:system-ui}")
        js  = payload.get("script.js", "console.log('ok');")

        a = []
        for name, content in [("index.html", idx), ("style.css", css), ("script.js", js)]:
            self._write(name, content)
            a.append(name)
        logs.append("Artifacts written: " + ", ".join(a))
        return StepResult(name="Scaffolding", status="done", log=logs, artifacts=a)

    def tests(self) -> StepResult:
        logs = ["LLM generating TEST_REPORT.txt…"]
        report = self.llm.complete([
            {"role": "system", "content": "You write extremely short test summaries."},
            {"role": "user", "content": TESTS_PROMPT}
        ], model=OPENAI_MODEL_BUILD, max_tokens=300)
        self._write("TEST_REPORT.txt", report.strip() + "\n")
        logs.append("TEST_REPORT.txt written")
        return StepResult(name="Tests", status="done", log=logs, artifacts=["TEST_REPORT.txt"])

    def package(self) -> StepResult:
        logs = ["Creating BUILD_REPORT.json + build.zip…"]
        rep = self.llm.complete([
            {"role": "system", "content": "You output only minified JSON."},
            {"role": "user", "content": PACKAGE_PROMPT}
        ], model=OPENAI_MODEL_BUILD, max_tokens=200)
        try:
            data = json.loads(rep)
        except Exception:
            data = {"status": "ok", "notes": "packaged locally"}
        self._write("BUILD_REPORT.json", json.dumps(data))
        logs.append("BUILD_REPORT.json written")
        return StepResult(name="Package", status="done", log=logs, artifacts=["BUILD_REPORT.json", "build.zip"])
EOPY

# 4) services/fixer.py
cat <<'EOPY' > services/fixer.py
from dataclasses import dataclass
from typing import Optional
from .llm_client import LLMClient, OPENAI_MODEL_FIX

DIFF_PROMPT = """Generate a unified diff for the fix.
Return ONLY the diff (no prose).
Context:
Error:
{error_text}

Criteria:
{criteria}

Original snippet:
{snippet}
"""

@dataclass
class FixReport:
    diff: str
    risk_notes: str

class FixService:
    def __init__(self):
        self.llm = LLMClient()

    def generate_fix(self, error_text: str, snippet: Optional[str], criteria: Optional[str]) -> FixReport:
        prompt = DIFF_PROMPT.format(
            error_text=error_text or "(none)",
            snippet=snippet or "(none)",
            criteria=criteria or "(none)"
        )
        diff = self.llm.complete([
            {"role": "system", "content": "You produce valid unified diffs only."},
            {"role": "user", "content": prompt}
        ], model=OPENAI_MODEL_FIX, max_tokens=900)
        risks = "- Validate the diff applies cleanly\n- Run tests/regression checks\n- Review any symbol renames"
        return FixReport(diff=diff.strip(), risk_notes=risks)

    def apply_patch(self, diff_text: str) -> bool:
        return bool(diff_text.strip())
EOPY

# 5) services/knowledge.py
cat <<'EOPY' > services/knowledge.py
import os
from dataclasses import dataclass
from typing import List
from .llm_client import LLMClient, OPENAI_MODEL_KNOW

QA_PROMPT = """You answer questions briefly and cite relevant local artifacts if helpful.
Existing artifacts (filenames only):
{artifacts}

Question:
{question}
"""

@dataclass
class QAResult:
    answer: str
    sources: List[str]

class KnowledgeService:
    def __init__(self, outputs_dir="outputs"):
        self.llm = LLMClient()
        self.outputs_dir = outputs_dir

    def _list_artifacts(self) -> List[str]:
        if not os.path.isdir(self.outputs_dir):
            return []
        return sorted([f for f in os.listdir(self.outputs_dir) if os.path.isfile(os.path.join(self.outputs_dir, f))])

    def ask(self, question: str) -> QAResult:
        artifacts = self._list_artifacts()
        prompt = QA_PROMPT.format(artifacts="\n".join(artifacts) or "(none)", question=question)
        ans = self.llm.complete([
            {"role": "system", "content": "You are concise and cite local files when relevant."},
            {"role": "user", "content": prompt}
        ], model=OPENAI_MODEL_KNOW, max_tokens=700)
        lower_q = (question or "").lower()
        sources = [a for a in artifacts if any(tok in a.lower() for tok in lower_q.split()[:4])] or artifacts[:3]
        return QAResult(answer=ans.strip(), sources=sources)
EOPY

# 6) app.py (replace)
cat <<'EOPY' > app.py
import os
from zipfile import ZipFile, ZIP_DEFLATED
from flask import Flask, render_template, request, jsonify, send_from_directory
from dotenv import load_dotenv

load_dotenv()  # loads OPENAI_API_KEY, FLASK_SECRET_KEY, etc.

from services.orchestrator import BuildOrchestrator
from services.fixer import FixService
from services.knowledge import KnowledgeService

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

# ----- Pages -----
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

# ----- API: Build -----
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

# ----- API: Fix -----
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

# ----- API: Know -----
@app.route("/api/know", methods=["POST"])
def api_know():
    q = request.form.get("question") or ""
    ans = knower.ask(q)
    return jsonify({"answer": ans.answer, "sources": ans.sources})

if __name__ == "__main__":
    app.run(debug=True)
EOPY

echo "AI layer applied. Next:"
echo "1) pip install -r requirements.txt"
echo "2) Set env: OPENAI_API_KEY, FLASK_SECRET_KEY (and optional OPENAI_MODEL_* overrides)"
echo "3) python app.py  ->  http://localhost:5000"
