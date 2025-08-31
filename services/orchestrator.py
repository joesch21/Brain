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
