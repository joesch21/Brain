import csv
import io
import json
from dataclasses import dataclass
from typing import Any, Dict, List, Literal

from .llm_client import LLMClient

ImportType = Literal["flights", "roster"]


@dataclass
class ParsedRow:
    data: Dict[str, Any]
    error: str | None = None


class ImportService:
    def __init__(self, db, ImportBatch, ImportRow, llm_client: LLMClient | None = None):
        self.db = db
        self.ImportBatch = ImportBatch
        self.ImportRow = ImportRow
        self.llm = llm_client or LLMClient()

    def create_batch(
        self,
        import_type: ImportType,
        source_filename: str | None,
        source_mime: str | None,
        created_by: str | None,
    ):
        batch = self.ImportBatch(
            import_type=import_type,
            source_filename=source_filename,
            source_mime=source_mime,
            created_by=created_by,
            status="pending",
        )
        self.db.session.add(batch)
        self.db.session.commit()
        return batch

    def parse_file_to_rows(
        self,
        import_type: ImportType,
        file_storage,
    ) -> List[ParsedRow]:
        filename = file_storage.filename or ""
        content = file_storage.read()

        ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""

        if ext in ("csv",):
            return self._parse_csv(import_type, content)
        if ext in ("xls", "xlsx"):
            return self._parse_excel(import_type, content)

        text = self._extract_text(filename, content)
        return self._parse_text_with_llm(import_type, text)

    def _parse_csv(self, import_type: ImportType, content: bytes) -> List[ParsedRow]:
        text = content.decode("utf-8", errors="ignore")
        reader = csv.DictReader(io.StringIO(text))
        rows = [dict(r) for r in reader]
        return self._normalize_rows(import_type, rows)

    def _parse_excel(self, import_type: ImportType, content: bytes) -> List[ParsedRow]:
        import pandas as pd

        buf = io.BytesIO(content)
        df = pd.read_excel(buf)
        rows = df.to_dict(orient="records")
        return self._normalize_rows(import_type, rows)

    def _extract_text(self, filename: str, content: bytes) -> str:
        ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""

        if ext == "pdf":
            try:
                import pdfplumber

                with pdfplumber.open(io.BytesIO(content)) as pdf:
                    pages = [page.extract_text() or "" for page in pdf.pages]
                return "\n\n".join(pages)
            except Exception:
                pass

        if ext in ("png", "jpg", "jpeg"):
            return "[IMAGE_CONTENT]\n(Implement OCR/vision in next iteration.)"

        try:
            return content.decode("utf-8", errors="ignore")
        except Exception:
            return ""

    def _parse_text_with_llm(self, import_type: ImportType, text: str) -> List[ParsedRow]:
        if not text.strip():
            return []

        schema_hint = ""
        if import_type == "flights":
            schema_hint = """Return a JSON array of flight objects with keys:
- flight_number (string)
- date (YYYY-MM-DD)
- origin (string)
- destination (string)
- eta_local (HH:MM, 24h)
- etd_local (HH:MM, 24h) or null
- tail_number (string or null)
- truck_assignment (string or null)
- status (string or null)
- notes (string or null)
"""
        else:
            schema_hint = """Return a JSON array of roster objects with keys:
- date (YYYY-MM-DD)
- employee_name (string)
- role (string)
- shift_start (HH:MM, 24h) or null
- shift_end (HH:MM, 24h) or null
- truck (string or null)
- notes (string or null)
"""

        prompt = f"""
You are helping ingest operational data for a refuelling company.

Input text (from PDF/email/other):

{text[:6000]}

{schema_hint}
Make sure the output is valid JSON only, no explanations.
"""
        raw = self.llm.complete(
            [
                {"role": "system", "content": "You are a precise JSON data extractor."},
                {"role": "user", "content": prompt},
            ],
            max_tokens=1200,
        )

        try:
            parsed = json.loads(raw)
            if not isinstance(parsed, list):
                parsed = []
        except Exception:
            parsed = []

        rows: List[ParsedRow] = []
        for item in parsed:
            if not isinstance(item, dict):
                continue
            normalized = self._normalize_row_keys(import_type, item)
            rows.append(ParsedRow(data=normalized))
        return rows

    def _normalize_rows(self, import_type: ImportType, rows: list[dict]) -> List[ParsedRow]:
        normalized = []
        for row in rows:
            normalized.append(ParsedRow(data=self._normalize_row_keys(import_type, row)))
        return normalized

    def _normalize_row_keys(self, import_type: ImportType, row: dict) -> dict:
        lower = {k.lower(): v for k, v in row.items()}
        if import_type == "flights":
            return {
                "flight_number": lower.get("flight_number") or lower.get("flight") or "",
                "date": lower.get("date"),
                "origin": lower.get("origin"),
                "destination": lower.get("destination"),
                "eta_local": lower.get("eta_local") or lower.get("eta"),
                "etd_local": lower.get("etd_local") or lower.get("etd"),
                "tail_number": lower.get("tail_number"),
                "truck_assignment": lower.get("truck_assignment") or lower.get("truck"),
                "status": lower.get("status"),
                "notes": lower.get("notes"),
            }
        return {
            "date": lower.get("date"),
            "employee_name": lower.get("employee_name") or lower.get("name") or "",
            "role": lower.get("role"),
            "shift_start": lower.get("shift_start"),
            "shift_end": lower.get("shift_end"),
            "truck": lower.get("truck"),
            "notes": lower.get("notes"),
        }
