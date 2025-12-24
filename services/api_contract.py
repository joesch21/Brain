"""Centralized API contract for the Brain web-backend proxy."""
from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Dict, List, Tuple

API_BASE_HINT = "/api"
REQUIRED_TOP_LEVEL_KEYS = [
    "service_name",
    "environment",
    "version",
    "generated_at",
    "api_base_hint",
    "endpoints",
]
REQUIRED_ENDPOINT_KEYS = ["name", "method", "path"]


def _environment_name() -> str:
    return os.getenv("APP_ENV") or os.getenv("ENVIRONMENT") or os.getenv("FLASK_ENV") or "development"


def _version() -> str:
    return os.getenv("BRAIN_VERSION") or os.getenv("RENDER_GIT_COMMIT") or "dev"


def _generated_at() -> str:
    return datetime.now(timezone.utc).isoformat()


def _minimum_endpoints() -> List[Dict[str, Any]]:
    return [
        {
            "name": "flights_daily",
            "method": "GET",
            "path": "/flights",
            "query": {
                "date": "YYYY-MM-DD (required)",
                "airport": "YSSY (optional)",
                "operator": "ALL or operator code (optional, default ALL)",
            },
            "maps_to": [
                "/api/flights",
                "/api/ops/flights",
                "/api/ops/schedule/flights",
            ],
            "response_shape": {"flights": "list", "source": "upstream|compatibility"},
        },
        {
            "name": "staff_list",
            "method": "GET",
            "path": "/staff",
            "maps_to": [
                "/api/staff",
                "/api/ops/staff",
                "/api/ops/people",
            ],
            "response_shape": {"staff": "list", "source": "upstream|compatibility"},
        },
        {
            "name": "runs",
            "method": "GET",
            "path": "/runs",
            "query": {
                "date": "YYYY-MM-DD (required)",
                "airport": "YSSY (required)",
                "operator": "ALL or operator code (optional, default ALL)",
                "shift": "ALL or shift code (optional, default ALL)",
            },
            "maps_to": [
                "/api/runs",
            ],
            "response_shape": {
                "runs": "list",
                "unassigned_flights": "list",
                "source": "upstream|compatibility",
            },
        },
        {
            "name": "runs_auto_assign",
            "method": "POST",
            "path": "/runs/auto_assign",
            "body": {
                "date": "YYYY-MM-DD (required)",
                "operator": "ALL or operator code (optional, default ALL)",
            },
            "maps_to": ["/api/runs/auto_assign"],
            "response_shape": {"ok": "bool"},
        },
        {
            "name": "wiring_status",
            "method": "GET",
            "path": "/wiring-status",
            "maps_to": ["/api/wiring-status"],
            "response_shape": {"ok": "bool"},
        },
        {
            "name": "api_contract",
            "method": "GET",
            "path": "/contract",
            "maps_to": ["/api/contract"],
            "notes": "Returns this contract document.",
        },
    ]


def build_contract() -> Dict[str, Any]:
    """Construct the API contract object for the Brain UI."""

    contract: Dict[str, Any] = {
        "service_name": "BrainOpsProxy",
        "environment": _environment_name(),
        "version": _version(),
        "generated_at": _generated_at(),
        "api_base_hint": API_BASE_HINT,
        "endpoints": _minimum_endpoints(),
    }
    return contract


def validate_contract(contract: Dict[str, Any]) -> Tuple[bool, Dict[str, Any]]:
    """Lightweight validation for the API contract payload."""

    missing_keys = [key for key in REQUIRED_TOP_LEVEL_KEYS if key not in contract]
    if missing_keys:
        return False, {"missing_top_level": missing_keys}

    endpoints = contract.get("endpoints")
    if not isinstance(endpoints, list):
        return False, {"endpoints": "must be a list"}

    for idx, endpoint in enumerate(endpoints):
        if not isinstance(endpoint, dict):
            return False, {"endpoint_index": idx, "error": "endpoint must be an object"}

        missing_endpoint_keys = [key for key in REQUIRED_ENDPOINT_KEYS if key not in endpoint]
        if missing_endpoint_keys:
            return False, {"endpoint_index": idx, "missing_keys": missing_endpoint_keys}

    return True, {}
