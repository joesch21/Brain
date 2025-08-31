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
