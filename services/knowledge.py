import os
from dataclasses import dataclass
from typing import List
from .llm_client import LLMClient, OPENAI_MODEL_KNOW
from .vectorstore import VectorStore

QA_PROMPT = """You are CodeCrafter-Know.
Answer the question using the provided artifact context when relevant.
Be concise. Cite the artifacts in 'Sources'.
---
Question:
{question}
---
Artifacts:
{context}
"""

@dataclass
class QAResult:
    answer: str
    sources: List[str]

class KnowledgeService:
    def __init__(self, outputs_dir="outputs"):
        self.llm = LLMClient()
        self.store = VectorStore(outputs_dir=outputs_dir)

    def ask(self, question: str) -> QAResult:
        self.store.ensure_embeddings()
        hits = self.store.search(question, top_k=3)
        context = "\n---\n".join([f"{fn}:\n{rec['preview']}" for _, fn, rec in hits])
        prompt = QA_PROMPT.format(question=question, context=context or "(no artifacts)")
        ans = self.llm.complete([
            {"role": "system", "content": "You are concise, source-aware."},
            {"role": "user", "content": prompt}
        ], model=OPENAI_MODEL_KNOW, max_tokens=700)
        sources = [fn for _, fn, _ in hits]
        return QAResult(answer=ans.strip(), sources=sources or [])
