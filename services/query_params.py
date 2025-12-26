"""Helpers for normalizing request query parameters."""
from __future__ import annotations

from typing import Any, Mapping, Optional, Tuple

from flask import jsonify


def normalize_airline_query(
    args: Mapping[str, Any],
    *,
    default: str = "ALL",
) -> Tuple[Optional[str], Optional[Tuple[Any, int]]]:
    """Normalize airline/operator query params.

    Accepts legacy `operator` but enforces that `airline` is the canonical name.
    """
    airlines_multi = []
    if hasattr(args, "getlist"):
        try:
            airlines_multi = args.getlist("airline")
        except Exception:  # noqa: BLE001
            airlines_multi = []

    airline_raw = str(args.get("airline") or "").strip()
    operator_raw = str(args.get("operator") or "").strip()

    if airline_raw and operator_raw:
        if airline_raw.upper() != operator_raw.upper():
            return None, (
                jsonify(
                    {
                        "ok": False,
                        "type": "bad_request",
                        "error": "airline and operator differ; use airline only.",
                    }
                ),
                400,
            )
    elif not airline_raw and operator_raw:
        airline_raw = operator_raw
    elif airlines_multi:
        collected = []
        for value in airlines_multi:
            if value is None:
                continue
            text = str(value).strip()
            if not text:
                continue
            collected.extend([part.strip() for part in text.split(",") if part.strip()])
        if collected:
            airline_raw = ",".join(collected)

    normalized = (airline_raw or default).strip()
    if not normalized or normalized.upper() in ("ALL", "*"):
        return "ALL", None
    normalized = ",".join([part.strip().upper() for part in normalized.split(",") if part.strip()])
    return normalized or default, None


def parse_airlines_set(airline_param: Optional[str]) -> Tuple[bool, set[str]]:
    """Return (mode_all, set_of_airline_codes) from normalized airline param."""
    if not airline_param:
        return True, set()
    value = str(airline_param).strip().upper()
    if value in ("ALL", "*"):
        return True, set()
    parts = [part.strip().upper() for part in value.split(",") if part.strip()]
    return False, set(parts)
