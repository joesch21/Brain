import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests
from flask import Flask, g, jsonify, request
from dotenv import load_dotenv

from services import api_contract

# EWOT: This app is a thin proxy between The Brain frontend and the
# CodeCrafter2 Ops API. It exposes /api/* endpoints that forward to CC2
# and returns JSON, so the React frontend never sees HTML 404s.

# Load environment variables (including CC2_UPSTREAM_BASE)
load_dotenv()

app = Flask(__name__)

def _env_flag(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() in {"1", "true", "yes", "on"}


DEFAULT_CC2_UPSTREAM_BASE = "https://code-crafter2-ay6w.onrender.com"

CONFIGURED_UPSTREAM_BASE_URL = (
    os.getenv("CC2_UPSTREAM_BASE")
    or os.getenv("CODECRAFTER2_BASE_URL")
    or DEFAULT_CC2_UPSTREAM_BASE
).rstrip("/")

DEFAULT_UPSTREAM_CANDIDATES = [
    CONFIGURED_UPSTREAM_BASE_URL,
    DEFAULT_CC2_UPSTREAM_BASE,
    "https://codecrafter2.onrender.com",
]


def _deduped_candidates() -> List[str]:
    candidates: List[str] = []

    def _add(base_url: str):
        base_url = base_url.strip().rstrip("/")
        if base_url and base_url not in candidates:
            candidates.append(base_url)

    _add(CONFIGURED_UPSTREAM_BASE_URL)

    env_candidates = os.getenv("UPSTREAM_CANDIDATES")
    if env_candidates:
        for candidate in env_candidates.split(","):
            _add(candidate)

    for candidate in DEFAULT_UPSTREAM_CANDIDATES:
        _add(candidate)

    return candidates


class UpstreamSelector:
    def __init__(self, configured_base: str, ttl_minutes: int = 10):
        self.configured_base = configured_base.rstrip("/")
        self.candidates = _deduped_candidates()
        self.ttl_seconds = max(ttl_minutes, 1) * 60
        self._lock = threading.Lock()
        self._last_probe_at: Optional[float] = None
        self._active_base: str = self.configured_base
        self._last_canary_result: Dict[str, Any] = {}

    def _needs_refresh(self) -> bool:
        if self._last_probe_at is None:
            return True
        return (time.monotonic() - self._last_probe_at) > self.ttl_seconds

    def _probe_candidates(self) -> str:
        self._last_probe_at = time.monotonic()
        today = datetime.now(timezone.utc).date().isoformat()
        attempts: List[Dict[str, Any]] = []
        chosen_base = self.configured_base
        found_working = False

        for base_url in self.candidates:
            probe_url = f"{base_url}/api/ops/schedule/runs/daily"
            attempt: Dict[str, Any] = {"base_url": base_url}
            ok = False
            payload: Dict[str, Any] = {}
            try:
                resp = requests.get(
                    probe_url,
                    params={"date": today, "operator": "ALL"},
                    timeout=10,
                )
                attempt["status_code"] = resp.status_code
                try:
                    payload = resp.json()
                    attempt["response_ok"] = payload.get("ok") if isinstance(payload, dict) else False
                except Exception:  # noqa: BLE001
                    attempt["response_ok"] = False
                    attempt["body_snippet"] = resp.text[:200]

                ok = resp.status_code == 200 and isinstance(payload, dict) and payload.get("ok") is True
            except requests.RequestException as exc:
                attempt["error"] = str(exc)
            except Exception as exc:  # noqa: BLE001
                attempt["error"] = str(exc)

            attempt["ok"] = ok
            attempts.append(attempt)

            if ok:
                chosen_base = base_url.rstrip("/")
                found_working = True
                break

        self._active_base = chosen_base
        self._last_canary_result = {
            "ok": found_working,
            "selected_base_url": chosen_base,
            "attempts": attempts,
            "at": datetime.now(timezone.utc).isoformat(),
        }

        return self._active_base

    def get_active_base(self) -> str:
        with self._lock:
            if not self._needs_refresh():
                return self._active_base
            return self._probe_candidates()

    @property
    def last_canary_result(self) -> Dict[str, Any]:
        return self._last_canary_result


upstream_selector = UpstreamSelector(
    CONFIGURED_UPSTREAM_BASE_URL,
    ttl_minutes=int(os.getenv("UPSTREAM_SELECTION_CACHE_MINUTES", "10")),
)


def json_error(
    message: str,
    status_code: int = 500,
    code: str = "error",
    detail: Optional[Dict[str, Any]] = None,
):
    """Return normalized JSON error payloads for all /api/* routes."""

    payload: Dict[str, Any] = {
        "ok": False,
        "error": {
            "code": code,
            "message": message,
        },
    }
    if detail:
        payload["error"]["detail"] = detail
    return jsonify(payload), status_code


def _build_ok(payload: Dict[str, Any], status_code: int = 200):
    payload.setdefault("ok", True)
    return jsonify(payload), status_code


def _active_upstream_base() -> str:
    return upstream_selector.get_active_base()


def _upstream_url(path: str) -> str:
    """EWOT: join the CC2 base URL with a /api/... path safely."""
    path = path or ""
    if not path.startswith("/"):
        path = "/" + path
    return f"{_active_upstream_base()}{path}"


def _upstream_meta() -> Dict[str, Any]:
    return {
        "upstream_base_url_configured": CONFIGURED_UPSTREAM_BASE_URL,
        "upstream_base_url_active": _active_upstream_base(),
        "last_upstream_canary": upstream_selector.last_canary_result,
    }


def _call_upstream(
    paths: Iterable[str], method: str = "get", **kwargs: Dict[str, Any]
) -> Tuple[Optional[requests.Response], Optional[str]]:
    """
    Attempt one or more upstream paths, returning the first non-404 response.

    If every attempt returns 404 we give the final response back to the caller so it
    can decide on a compatibility fallback. Network failures raise a
    RequestException to allow the caller to surface an upstream_error.
    """

    last_resp: Optional[requests.Response] = None
    last_path: Optional[str] = None
    for candidate in paths:
        last_path = candidate
        try:
            resp = getattr(requests, method)(_upstream_url(candidate), **kwargs)
        except requests.RequestException:
            # Try the next candidate; bubble up if none succeed.
            last_resp = None
            continue

        if resp.status_code == 404:
            last_resp = resp
            continue
        return resp, candidate

    return last_resp, last_path


def _probe_route(
    paths: Iterable[str], method: str = "get", **kwargs: Dict[str, Any]
) -> bool:
    """Check whether any of the given upstream paths respond without 404/500."""

    try:
        resp, _ = _call_upstream(paths, method=method, **kwargs)
    except requests.RequestException:
        return False

    if resp is None:
        return False

    return resp.status_code < 500 and resp.status_code != 404


def _compatibility_wiring_snapshot() -> Dict[str, Any]:
    """Build a minimal wiring snapshot when upstream wiring-status is unavailable."""

    sample_date = datetime.now(timezone.utc).date().isoformat()

    contract = api_contract.build_contract()

    def _maps_to_candidates(endpoint_name: str, fallback: Iterable[str]) -> List[str]:
        for endpoint in contract.get("endpoints", []):
            if endpoint.get("name") == endpoint_name:
                maps_to = endpoint.get("maps_to") or []
                if isinstance(maps_to, list) and maps_to:
                    return [f"{path}?date={sample_date}&operator=ALL" for path in maps_to]
        return [f"{path}?date={sample_date}&operator=ALL" for path in fallback]

    flights_candidates = _maps_to_candidates(
        "flights_daily",
        [
            "/api/flights",
            "/api/ops/flights",
            "/api/ops/schedule/flights",
        ],
    )

    runs_candidates = _maps_to_candidates(
        "runs_daily",
        [
            "/api/runs/daily",
            "/api/ops/runs/daily",
            "/api/ops/schedule/runs/daily",
        ],
    )

    def _probe_candidates(paths: Iterable[str]) -> Tuple[bool, Optional[str], List[Dict[str, Any]]]:
        attempts: List[Dict[str, Any]] = []
        for path in paths:
            try:
                resp = requests.get(_upstream_url(path), timeout=8)
            except requests.RequestException as exc:
                attempts.append({"path": path, "error": str(exc)})
                continue

            attempt: Dict[str, Any] = {"path": path, "status": resp.status_code}
            is_success = resp.status_code == 200
            if not is_success:
                body_snippet = resp.text[:200]
                if body_snippet:
                    attempt["body_snippet"] = body_snippet
            attempts.append(attempt)

            if is_success:
                return True, path, attempts

        return False, None, attempts

    flights_probe_ok, flights_success_path, flights_probe_attempts = _probe_candidates(flights_candidates)
    runs_probe_ok, runs_success_path, runs_probe_attempts = _probe_candidates(runs_candidates)

    contract_ok, contract_detail = api_contract.validate_contract(contract)

    snapshot: Dict[str, Any] = {
        "contract_fetch_ok": bool(contract_ok),
        "flights_probe_ok": flights_probe_ok,
        "runs_probe_ok": runs_probe_ok,
        **_upstream_meta(),
        "probe_attempts": {"flights": flights_probe_attempts, "runs": runs_probe_attempts},
        "probe_success_path": {
            "flights": flights_success_path,
            "runs": runs_success_path,
        },
    }

    if not contract_ok and contract_detail:
        snapshot["contract_detail"] = contract_detail

    return snapshot


def _require_date_param() -> Optional[Tuple[Any, int]]:
    date_str = request.args.get("date")
    if not date_str:
        return json_error(
            "Missing required 'date' query parameter.",
            status_code=400,
            code="validation_error",
        )
    return None


# ---------------------------------------------------------------------------
# Basic health + status
# ---------------------------------------------------------------------------


@app.before_request
def _track_start_time():
    # Track per-request start time for logging.
    g.start_time = time.monotonic()


@app.after_request
def _log_request(response):  # noqa: D401 - simple logger
    """Log method, path, status, and duration for API endpoints."""

    try:
        should_log = request.path.startswith("/api/")
    except RuntimeError:
        should_log = False

    if should_log:
        duration_ms = int((time.monotonic() - getattr(g, "start_time", time.monotonic())) * 1000)
        app.logger.info(
            "%s %s -> %s (%sms)",
            request.method,
            request.path,
            response.status_code,
            duration_ms,
        )
    return response


@app.get("/api/healthz")
def api_healthz():
    """EWOT: simple health endpoint so we can see if the Brain proxy is up."""
    now = datetime.now(timezone.utc).isoformat()
    return _build_ok(
        {
            "service": "BrainOpsProxy",
            "time": now,
            "upstream": _upstream_meta(),
        }
    )


@app.get("/api/upstream")
def api_upstream_status():
    """Expose configured and active upstream base URLs plus last canary result."""

    active_base = _active_upstream_base()
    last_canary = upstream_selector.last_canary_result

    payload = {
        "configured_base_url": CONFIGURED_UPSTREAM_BASE_URL,
        "active_base_url": active_base,
        "last_canary": last_canary,
    }

    return _build_ok(payload)


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
            "error": {
                "code": "upstream_unavailable",
                "message": "Failed to reach upstream wiring-status.",
                "detail": str(exc),
            },
        }

    return _build_ok(
        {
            "date": date_str,
            "service": "BrainOpsProxy",
            "upstream": upstream,
            "upstream_meta": _upstream_meta(),
        }
    )


# ---------------------------------------------------------------------------
# Wiring / debug passthroughs
# ---------------------------------------------------------------------------







@app.get("/api/wiring-status")
def api_wiring_status():
    """EWOT: proxy wiring-status for Wiring Test / BackendDebugConsole."""
    candidate_paths = [
        "/api/wiring-status",
        "/api/ops/wiring-status",
        "/api/ops/admin/wiring-status",
        "/api/wiring",
    ]
    attempted_paths = []
    last_resp: Optional[requests.Response] = None
    last_error: Optional[str] = None

    for path in candidate_paths:
        try:
            resp = requests.get(_upstream_url(path), timeout=10)
        except requests.RequestException as exc:
            last_resp = None
            last_error = str(exc)
            attempted_paths.append({"path": path, "error": str(exc)})
            continue

        last_resp = resp
        attempt: Dict[str, Any] = {"path": path, "status": resp.status_code}
        body_snippet = resp.text[:200]
        if body_snippet:
            attempt["body_snippet"] = body_snippet
        attempted_paths.append(attempt)

        try:
            payload = resp.json()
        except Exception:  # noqa: BLE001
            continue

        payload.setdefault("ok", False)
        payload["upstream_path"] = path
        payload["attempted_paths"] = attempted_paths
        payload.update(_upstream_meta())
        return jsonify(payload), resp.status_code

    compatibility = _compatibility_wiring_snapshot()

    error_code = "upstream_non_json"
    detail: Dict[str, Any] = {"attempted_paths": attempted_paths}

    if last_resp is not None:
        error_code = "upstream_not_found" if last_resp.status_code == 404 else "upstream_non_json"
        detail["upstream_status"] = last_resp.status_code
        if last_resp.text:
            detail["upstream_body_snippet"] = last_resp.text[:200]
    elif last_error:
        error_code = "upstream_error"
        detail["error"] = last_error

    payload = {
        "ok": False,
        "source": "compatibility",
        "error": {
            "code": error_code,
            "message": "Unable to retrieve upstream wiring-status JSON.",
            "detail": detail,
        },
        "compatibility": compatibility,
    }

    payload.update(_upstream_meta())

    status_code = last_resp.status_code if last_resp is not None else 502
    return jsonify(payload), status_code


@app.get("/api/wiring")
def api_wiring_snapshot():
    """Augmented wiring snapshot with route checks and config flags."""

    sample_date = datetime.now(timezone.utc).date().isoformat()
    route_checks = {
        "flights": _probe_route([
            "/api/flights",
            "/api/ops/flights",
            "/api/ops/schedule/flights",
        ], params={"date": sample_date, "operator": "ALL"}),
        "staff": _probe_route([
            "/api/staff",
            "/api/ops/staff",
        ]),
        "runsDaily": _probe_route([
            "/api/runs/daily",
            "/api/ops/runs/daily",
            "/api/ops/schedule/runs/daily",
        ], params={"date": sample_date, "operator": "ALL"}),
        "autoAssign": _probe_route([
            "/api/runs/auto_assign",
        ], method="post", json={"date": sample_date, "operator": "ALL"}),
    }

    try:
        upstream_status = requests.get(_upstream_url("/api/wiring-status"), timeout=8).json()
    except Exception:  # noqa: BLE001
        upstream_status = {"ok": False}

    payload = {
        "ok": True,
        "routes": route_checks,
        "flights_source": "upstream",
        "config": {
            "demo_schedule": _env_flag("DEMO_SCHEDULE"),
            "db_backed": bool(os.getenv("DATABASE_URL")),
        },
        "db": {
            "available": False,
            "detail": "Proxy layer does not manage a database.",
        },
        "upstream": upstream_status,
    }

    return jsonify(payload)


@app.get("/api/contract")
def api_contract_route():
    """Expose a stable, machine-readable API contract for the Brain frontend."""

    contract = api_contract.build_contract()
    is_valid, detail = api_contract.validate_contract(contract)

    if not is_valid:
        app.logger.error("Invalid API contract payload: %s", detail)
        return json_error(
            "Invalid API contract payload.",
            status_code=500,
            code="invalid_contract",
            detail=detail,
        )

    return jsonify(contract)


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
            code="upstream_error",
            detail={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": {
                "code": "invalid_json",
                "message": "Invalid JSON from upstream ops debug wiring endpoint.",
                "detail": resp.text[:500],
            },
        }

    return jsonify(payload), resp.status_code


# ---------------------------------------------------------------------------
# Flights + roster / employee assignments
# ---------------------------------------------------------------------------


@app.get("/api/flights")
def api_flights():
    """Proxy GET /api/flights with legacy compatibility fallbacks."""

    if (date_error := _require_date_param()) is not None:
        return date_error

    operator = request.args.get("operator", "ALL")
    params = {"date": request.args.get("date"), "operator": operator}

    flights_paths = [
        "/api/flights",
        "/api/ops/flights",
        "/api/ops/schedule/flights",
    ]

    try:
        resp, used_path = _call_upstream(flights_paths, params=params, timeout=20)
    except requests.RequestException as exc:
        app.logger.exception("Failed to call CC2 flights endpoint")
        return json_error(
            "Upstream flights endpoint unavailable",
            status_code=502,
            code="upstream_error",
            detail={"detail": str(exc)},
        )

    if resp is None:
        return json_error(
            "Flights endpoint not reachable upstream.",
            status_code=502,
            code="upstream_unavailable",
        )

    if resp.status_code == 404:
        return _build_ok({"flights": [], "source": "compatibility", "upstream_path": used_path})

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return json_error(
            "Invalid JSON from flights backend.",
            status_code=502,
            code="invalid_json",
            detail={"raw": resp.text[:500]},
        )

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
            code="upstream_error",
            detail={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": {
                "code": "invalid_json",
                "message": "Invalid JSON from employee assignments backend.",
                "detail": resp.text[:500],
            },
        }

    return jsonify(payload), resp.status_code


@app.get("/api/staff")
def api_staff():
    """Compatibility endpoint for staff directory."""

    staff_paths = [
        "/api/staff",
        "/api/ops/staff",
        "/api/ops/people",
    ]

    try:
        resp, used_path = _call_upstream(staff_paths, timeout=15)
    except requests.RequestException as exc:
        app.logger.exception("Failed to call CC2 staff endpoint")
        return json_error(
            "Upstream staff endpoint unavailable",
            status_code=502,
            code="upstream_error",
            detail={"detail": str(exc)},
        )

    if resp is None:
        return json_error(
            "Staff endpoint not reachable upstream.",
            status_code=502,
            code="upstream_unavailable",
        )

    if resp.status_code == 404:
        return _build_ok({"staff": [], "source": "compatibility", "upstream_path": used_path})

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return json_error(
            "Invalid JSON from staff backend.",
            status_code=502,
            code="invalid_json",
            detail={"raw": resp.text[:500]},
        )

    return jsonify(payload), resp.status_code


# ---------------------------------------------------------------------------
# Runs daily + auto-assign (core of the Runs page)
# ---------------------------------------------------------------------------
@app.get("/api/runs")
def api_runs_cc3():
    """
    EWOT: Proxy CC3-style runs endpoint (GET /api/runs?date&airport&operator&shift)
    so Brain can talk to CC3 without the frontend doing direct cross-origin calls.
    """
    date_str = (request.args.get("date") or "").strip()
    airport = (request.args.get("airport") or "").strip().upper()

    if not date_str:
        return json_error(
            "Missing required 'date' query parameter.",
            status_code=400,
            code="validation_error",
        )
    if not airport:
        return json_error(
            "Missing required 'airport' query parameter.",
            status_code=400,
            code="validation_error",
        )

    try:
        resp = requests.get(
            _upstream_url("/api/runs"),
            params=request.args,
            timeout=30,
        )
    except requests.RequestException as exc:
        app.logger.exception("Failed to call upstream /api/runs")
        return json_error(
            "Upstream /api/runs endpoint unavailable",
            status_code=502,
            code="upstream_error",
            detail={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return json_error(
            "Invalid JSON from upstream /api/runs.",
            status_code=502,
            code="invalid_json",
            detail={"raw": resp.text[:500]},
        )

    return jsonify(payload), resp.status_code
@app.get("/api/runs/sheet", endpoint="api_runs_sheet_proxy_cc3")
def api_runs_sheet_cc3():
    """
    EWOT: Direct proxy for CC3 /api/runs/sheet.
    No fallback, no probing, no path mutation.
    """
    upstream = _active_upstream_base().rstrip("/")
    url = f"{upstream}/api/runs/sheet"

    try:
        resp = requests.get(url, params=request.args, timeout=30)
    except requests.RequestException as exc:
        return json_error(
            "Upstream /api/runs/sheet unreachable",
            status_code=502,
            code="upstream_error",
            detail={"error": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return json_error(
            "Invalid JSON from upstream /api/runs/sheet.",
            status_code=502,
            code="invalid_json",
            detail={"raw": resp.text[:300]},
        )

    return jsonify(payload), resp.status_code


@app.get("/api/runs/daily")
def api_runs_daily():
    """
    EWOT: proxy GET /api/runs/daily so the Runs page can fetch runs
    for a given date + operator without seeing 404s from the Brain backend.
    """
    if (date_error := _require_date_param()) is not None:
        return date_error

    date_str = request.args.get("date")
    operator = request.args.get("operator", "ALL")

    params = {"date": date_str, "operator": operator}

    runs_paths = [
        "/api/runs/daily",
        "/api/ops/runs/daily",
        "/api/ops/schedule/runs/daily",
    ]

    try:
        resp, used_path = _call_upstream(runs_paths, params=params, timeout=30)
    except requests.RequestException as exc:
        app.logger.exception("Failed to call CC2 /api/runs/daily")
        return json_error(
            "Upstream runs endpoint unavailable",
            status_code=502,
            code="upstream_error",
            detail={"detail": str(exc)},
        )

    if resp is None:
        return json_error(
            "Runs endpoint not reachable upstream.",
            status_code=502,
            code="upstream_unavailable",
        )

    if resp.status_code == 404:
        return _build_ok(
            {
                "date": date_str,
                "operator": operator,
                "runs": [],
                "unassigned_flights": [],
                "source": "compatibility",
                "upstream_path": used_path,
            }
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return json_error(
            "Invalid JSON from runs backend.",
            status_code=502,
            code="invalid_json",
            detail={"raw": resp.text[:500]},
        )

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
            code="validation_error",
            detail={"body": data},
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
            code="upstream_error",
            detail={"detail": str(exc)},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {
            "ok": False,
            "error": {
                "code": "invalid_json",
                "message": "Invalid JSON from runs auto-assign backend.",
                "detail": resp.text[:500],
            },
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
        f"<p>Configured upstream: <code>{CONFIGURED_UPSTREAM_BASE_URL}</code></p>"
        f"<p>Active upstream: <code>{_active_upstream_base()}</code></p>",
        200,
        {"Content-Type": "text/html; charset=utf-8"},
    )


if __name__ == "__main__":  # pragma: no cover
    # Local dev convenience; in production Render will run via gunicorn.
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5055")), debug=True)
