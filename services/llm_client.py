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
