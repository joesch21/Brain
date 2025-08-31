#!/usr/bin/env bash
set -euo pipefail

mkdir -p services

# requirements.txt ensure numpy present
touch requirements.txt
grep -q '^numpy' requirements.txt || echo 'numpy>=1.26.0' >> requirements.txt
grep -q '^openai' requirements.txt || echo 'openai>=1.40.0' >> requirements.txt

# services/vectorstore.py
cat <<'EOF2' > services/vectorstore.py
import os, json
import numpy as np
from openai import OpenAI

EMBED_MODEL = os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small")

class VectorStore:
    def __init__(self, outputs_dir="outputs"):
        self.outputs_dir = outputs_dir
        self.cache_path = os.path.join(outputs_dir, ".embeddings.json")
        self.client = OpenAI()
        self._load()

    def _load(self):
        if os.path.exists(self.cache_path):
            with open(self.cache_path, "r", encoding="utf-8") as f:
                self.cache = json.load(f)
        else:
            self.cache = {}

    def _save(self):
        with open(self.cache_path, "w", encoding="utf-8") as f:
            json.dump(self.cache, f)

    def _embed(self, text: str):
        resp = self.client.embeddings.create(model=EMBED_MODEL, input=text)
        return resp.data[0].embedding

    def ensure_embeddings(self):
        changed = False
        if not os.path.isdir(self.outputs_dir):
            os.makedirs(self.outputs_dir, exist_ok=True)
        for fn in os.listdir(self.outputs_dir):
            fp = os.path.join(self.outputs_dir, fn)
            if not os.path.isfile(fp) or fn.startswith("."):
                continue
            stat = os.stat(fp).st_mtime
            rec = self.cache.get(fn)
            if (rec is None) or (rec.get("mtime", 0) < stat):
                with open(fp, "r", encoding="utf-8", errors="ignore") as f:
                    content = f.read()[:2000]
                vec = self._embed(content)
                self.cache[fn] = {"mtime": stat, "vec": vec, "preview": content[:300]}
                changed = True
        if changed:
            self._save()

    def search(self, query: str, top_k=3):
        if not self.cache:
            return []
        qvec = np.array(self._embed(query))
        sims = []
        qn = np.linalg.norm(qvec) + 1e-6
        for fn, rec in self.cache.items():
            v = np.array(rec["vec"])
            score = float(np.dot(v, qvec) / (np.linalg.norm(v)*qn + 1e-6))
            sims.append((score, fn, rec))
        sims.sort(reverse=True)
        return sims[:top_k]
EOF2

# services/knowledge.py
cat <<'EOF2' > services/knowledge.py
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
EOF2

echo "RAG layer applied. Next:"
echo "1) pip install -r requirements.txt"
echo "2) Ensure OPENAI_API_KEY is set (and optional OPENAI_EMBED_MODEL)"
echo "3) python app.py"
