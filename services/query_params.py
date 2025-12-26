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

    normalized = (airline_raw or default).strip().upper() or default
    return normalized, None
