import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import requests
from flask import Flask, jsonify, request
from dotenv import load_dotenv

# EWOT: This app is a thin proxy between The Brain frontend and the
# CodeCrafter2 Ops API. It exposes /api/* endpoints that forward to CC2
# and returns JSON, so the React frontend never sees HTML 404s.

# Load environment variables (including CODECRAFTER2_BASE_URL)
load_dotenv()

app = Flask(__name__)

# Base URL for the CodeCrafter2 Ops API (backend)
CODECRAFTER2_BASE_URL = (
    os.getenv("CODECRAFTER2_BASE_URL", "https://codecrafter2.onrender.com").rstrip("/")
)


def json_error(
    message: str,
    status_code: int = 500,
    error_type: str = "error",
    context: Optional[Dict[str, Any]] = None,
):
    """
    EWOT: helper to return a consistent JSON error payload.

    The Brain frontend can rely on { ok, error, type, context? } instead of
    HTML error pages or stack traces.
    """
    payload: Dict[str, Any] = {
        "ok": False,
        "error": message,
        "type": error_type,
    }
    if context:
        payload["context"] = context
    return jsonify(payload), status_code


def _upstream_url(path: str) -> str:
    """EWOT: join the CC2 base URL with a /api/... path safely."""
    path = path or ""
    if not path.startswith("/"):
        path = "/" + path
    return f"{CODECRAFTER2_BASE_URL}{path}"


# ---------------------------------------------------------------------------
# Basic health + status
# ---------------------------------------------------------------------------


@app.get("/api/healthz")
def api_healthz():
    """EWOT: simple health endpoint so we can see if the Brain proxy is up."""
    now = datetime.now(timezone.utc).isoformat()
    return jsonify(
        {
            "ok": True,
            "service": "BrainOpsProxy",
            "time": now,
            "upstream": {"base_url": CODECRAFTER2_BASE_URL},
        }
    )


@app.get("/api/status")
def api_status():
    """
    EWOT: lightweight status endpoint.

    Always returns JSON, even if CodeCrafter2 is down.
    """
    date_str = request.args.get("date")

    # Try a wiring-status ping for richer info; swallow failures.
    try:
        resp = requests.get(_upstream_url("/api/wiring-status"), timeout=5)
        upstream = resp.json()
    except Exception as exc:  # noqa: BLE001
        upstream = {
            "ok": False,
            "error": "Failed to reach upstream wiring-status.",
            "detail": str(exc),
        }

    return jsonify(
        {
            "ok": True,
            "date": date_str,
            "service": "BrainOpsProxy",
            "upstream": upstream,
        }
    )


# ---------------------------------------------------------------------------
# Wiring / debug passthroughs
# ---------------------------------------------------------------------------


@app.get("/api/wiring-status")
def api_wiring_status():
    """EWOT: proxy wiring-status for Wiring Test / BackendDebugConsole."""
    try:
        resp = requests.get(_upstream_url("/api/wiring-status"), timeout=10)
    except requests.RequestException as exc:
        app.logger.exception("Failed to reach CC2 /api/wiring-status")
        return json_error(
            "Upstream wiring-status endpoint unavailable",
            status_code=502,
            error_type="upstream_error",
            context={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": "Invalid JSON from upstream wiring-status endpoint.",
            "raw": resp.text[:500],
        }

    return jsonify(payload), resp.status_code


@app.get("/api/ops/debug/wiring")
def api_ops_debug_wiring():
    """EWOT: proxy the richer debug wiring endpoint used by WiringTestPanel."""
    try:
        resp = requests.get(_upstream_url("/api/ops/debug/wiring"), timeout=10)
    except requests.RequestException as exc:
        app.logger.exception("Failed to reach CC2 /api/ops/debug/wiring")
        return json_error(
            "Upstream ops debug wiring endpoint unavailable",
            status_code=502,
            error_type="upstream_error",
            context={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": "Invalid JSON from upstream ops debug wiring endpoint.",
            "raw": resp.text[:500],
        }

    return jsonify(payload), resp.status_code


# ---------------------------------------------------------------------------
# Flights + roster / employee assignments
# ---------------------------------------------------------------------------


@app.get("/api/flights")
def api_flights():
    """EWOT: proxy GET /api/flights to CC2 for schedule / runs views."""
    try:
        resp = requests.get(
            _upstream_url("/api/flights"),
            params=request.args,
            timeout=20,
        )
    except requests.RequestException as exc:
        app.logger.exception("Failed to call CC2 /api/flights")
        return json_error(
            "Upstream flights endpoint unavailable",
            status_code=502,
            error_type="upstream_error",
            context={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": "Invalid JSON from flights backend.",
            "raw": resp.text[:500],
        }

    return jsonify(payload), resp.status_code


@app.get("/api/employee_assignments/daily")
def api_employee_assignments_daily():
    """
    EWOT: proxy /api/employee_assignments/daily so Brain can build
    roster-driven operator dropdowns and staff views from CC2.
    """
    try:
        resp = requests.get(
            _upstream_url("/api/employee_assignments/daily"),
            params=request.args,
            timeout=20,
        )
    except requests.RequestException as exc:
        app.logger.exception("Failed to call CC2 /api/employee_assignments/daily")
        return json_error(
            "Upstream employee assignments endpoint unavailable",
            status_code=502,
            error_type="upstream_error",
            context={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": "Invalid JSON from employee assignments backend.",
            "raw": resp.text[:500],
        }

    return jsonify(payload), resp.status_code


# ---------------------------------------------------------------------------
# Runs daily + auto-assign (core of the Runs page)
# ---------------------------------------------------------------------------


@app.get("/api/runs/daily")
def api_runs_daily():
    """
    EWOT: proxy GET /api/runs/daily so the Runs page can fetch runs
    for a given date + operator without seeing 404s from the Brain backend.
    """
    date_str = request.args.get("date")
    operator = request.args.get("operator", "ALL")

    if not date_str:
        return json_error(
            "Missing required 'date' query parameter.",
            status_code=400,
            error_type="validation_error",
        )

    params = {"date": date_str, "operator": operator}

    try:
        resp = requests.get(
            _upstream_url("/api/runs/daily"),
            params=params,
            timeout=30,
        )
    except requests.RequestException as exc:
        app.logger.exception("Failed to call CC2 /api/runs/daily")
        return json_error(
            "Upstream runs endpoint unavailable",
            status_code=502,
            error_type="upstream_error",
            context={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": "Invalid JSON from runs backend.",
            "raw": resp.text[:500],
        }

    return jsonify(payload), resp.status_code


@app.post("/api/runs/auto_assign")
def api_runs_auto_assign():
    """
    EWOT: proxy POST /api/runs/auto_assign so the Runs page Auto-assign
    button forwards to CC2 and returns its result.
    """
    data = request.get_json(silent=True) or {}
    date_str = data.get("date")
    operator = data.get("operator") or "ALL"

    if not date_str:
        return json_error(
            "Missing 'date' field in JSON body.",
            status_code=400,
            error_type="validation_error",
            context={"body": data},
        )

    upstream_body = {"date": date_str, "operator": operator}

    try:
        resp = requests.post(
            _upstream_url("/api/runs/auto_assign"),
            json=upstream_body,
            timeout=60,
        )
    except requests.RequestException as exc:
        app.logger.exception("Failed to call CC2 /api/runs/auto_assign")
        return json_error(
            "Upstream runs auto-assign endpoint unavailable",
            status_code=502,
            error_type="upstream_error",
            context={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": "Invalid JSON from runs auto-assign backend.",
            "raw": resp.text[:500],
        }

    return jsonify(payload), resp.status_code


# ---------------------------------------------------------------------------
# Root page (optional – simple text so you know it's alive)
# ---------------------------------------------------------------------------


@app.route("/", methods=["GET", "HEAD"])
def home():
    """EWOT: tiny landing page to show the proxy is running."""
    return (
        "<!doctype html>"
        "<meta charset='utf-8'>"
        "<title>Brain Ops Proxy</title>"
        "<h1>Brain Ops Proxy</h1>"
        "<p>Service is up. Health: <code>/api/healthz</code></p>"
        f"<p>Upstream: <code>{CODECRAFTER2_BASE_URL}</code></p>",
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )


if __name__ == "__main__":  # pragma: no cover
    # Local dev convenience; in production Render will run via gunicorn.
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
