import os
import threading
import time
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests
from flask import Flask, g, jsonify, redirect, render_template, request, url_for
from dotenv import load_dotenv

from services import api_contract

# EWOT: This app is a thin proxy between The Brain frontend and the
# CodeCrafter2 Ops API. It exposes /api/* endpoints that forward to CC2
# and returns JSON, so the React frontend never sees HTML 404s.

# Load environment variables (including CC2_UPSTREAM_BASE)
load_dotenv()

app = Flask(__name__)

# ---------------------------------------------------------------------------
# Jinja helpers required by templates/_layout.html
# ---------------------------------------------------------------------------


def get_current_role() -> str:
    """
    Returns the current UI role.
    Minimal default to unblock templates; can be expanded later.
    """

    return "ops"


# Expose as a Jinja global so templates can call get_current_role()
app.jinja_env.globals["get_current_role"] = get_current_role


# Ensure current_role is always present in template context
@app.context_processor
def inject_current_role():
    return {"current_role": get_current_role()}

def _env_flag(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() in {"1", "true", "yes", "on"}


### BEGIN CWO_BRAIN_006 upstream selection
# --- Upstream base URL selection (prefer CC3; keep CC2 fallbacks) ---

DEFAULT_CC3_UPSTREAM_BASE = "https://code-crafter3.onrender.com"
DEFAULT_CC2_UPSTREAM_BASE = "https://code-crafter2-ay6w.onrender.com"

# Prefer OPS_API_BASE (CC3) if provided; otherwise keep legacy env names
CONFIGURED_UPSTREAM_BASE_URL = (
    os.getenv("OPS_API_BASE")
    or os.getenv("CODE_CRAFTER2_API_BASE")      # legacy
    or os.getenv("CODECRAFTER2_BASE_URL")       # legacy
    or ""
).strip()

FALLBACK_BASE_URLS = [
    CONFIGURED_UPSTREAM_BASE_URL,
    DEFAULT_CC3_UPSTREAM_BASE,                  # NEW: ensure CC3 is tried early
    DEFAULT_CC2_UPSTREAM_BASE,                  # legacy default
    "https://codecrafter2.onrender.com",        # legacy alias
]

def upstream_candidates():
    # de-dupe while preserving order
    out = []
    for b in FALLBACK_BASE_URLS:
        b = (b or "").strip().rstrip("/")
        if b and b not in out:
            out.append(b)
    return out

# Candidate bases for canary/probes/proxying
_CANDIDATE_BASE_URLS = upstream_candidates()
### END CWO_BRAIN_006 upstream selection


class UpstreamSelector:
    def __init__(self, configured_base: str, ttl_minutes: int = 10):
        self.configured_base = configured_base.rstrip("/")
        self.candidates = _CANDIDATE_BASE_URLS
        self.ttl_seconds = max(ttl_minutes, 1) * 60
        self._lock = threading.Lock()
        self._last_probe_at: Optional[float] = None
        self._active_base: str = self.configured_base or (self.candidates[0] if self.candidates else "")
        self._last_canary_result: Dict[str, Any] = {}

    def _needs_refresh(self) -> bool:
        if self._last_probe_at is None:
            return True
        return (time.monotonic() - self._last_probe_at) > self.ttl_seconds

    def _probe_candidates(self) -> str:
        self._last_probe_at = time.monotonic()
        attempts: List[Dict[str, Any]] = []
        chosen_base = self._active_base
        found_working = False
        probe_path = "/api/wiring-status"

        for base_url in self.candidates:
            base_url = base_url.rstrip("/")
            probe_url = f"{base_url}{probe_path}"
            attempt: Dict[str, Any] = {"base_url": base_url, "path": probe_path}
            ok = False
            try:
                resp = requests.get(
                    probe_url,
                    timeout=20,
                )
                attempt["status_code"] = resp.status_code
                if resp.text:
                    attempt["body_snippet"] = resp.text[:200]

                ok = resp.status_code == 200
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
            if not self._active_base and self.candidates:
                self._active_base = self.candidates[0]
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
    base = _active_upstream_base()
    if not base:
        raise requests.exceptions.InvalidURL("No upstream base URL configured or discovered.")
    return f"{base}{path}"


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
    active_base = _active_upstream_base().rstrip("/")
    url = f"{active_base}/api/wiring-status"

    start_ts = time.monotonic()
    app.logger.info("wiring-status: selected_upstream=%s", active_base)

    try:
        resp = requests.get(url, timeout=10)
        duration = time.monotonic() - start_ts
        app.logger.info(
            "wiring-status: upstream_status=%s duration_sec=%.3f", resp.status_code, duration
        )
    except requests.RequestException as exc:
        duration = time.monotonic() - start_ts
        app.logger.warning(
            "wiring-status: upstream_failed duration_sec=%.3f reason=%s", duration, exc
        )
        payload = {
            "ok": False,
            "source": "fallback",
            "error": {
                "code": "upstream_error",
                "message": "Unable to retrieve upstream wiring-status JSON.",
                "detail": {"error": str(exc)},
            },
            "metrics": {"duration_seconds": duration},
        }
        payload.update(_upstream_meta())
        return jsonify(payload), 502

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        duration = time.monotonic() - start_ts
        app.logger.warning(
            "wiring-status: upstream_non_json status=%s duration_sec=%.3f", resp.status_code, duration
        )
        payload = {
            "ok": False,
            "source": "fallback",
            "error": {
                "code": "upstream_non_json",
                "message": "Unable to retrieve upstream wiring-status JSON.",
                "detail": {
                    "status": resp.status_code,
                    "body_snippet": resp.text[:200],
                },
            },
            "metrics": {"duration_seconds": duration},
        }
        payload.update(_upstream_meta())
        return jsonify(payload), resp.status_code

    duration = time.monotonic() - start_ts
    payload.setdefault("ok", False)
    payload["upstream_path"] = "/api/wiring-status"
    payload["upstream_status_code"] = resp.status_code
    payload["metrics"] = {"duration_seconds": duration}
    payload.update(_upstream_meta())
    return jsonify(payload), resp.status_code


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
    params = request.args.to_dict(flat=True)
    params["date"] = date_str
    params["airport"] = airport

    active_base = _active_upstream_base().rstrip("/")

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
            f"{active_base}/api/runs",
            params=params,
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

    run_no_raw = request.args.get("run_no") or request.args.get("run_id")
    if run_no_raw is None:
        return json_error(
            "Missing required 'run_no' or 'run_id' query parameter.",
            status_code=400,
            code="validation_error",
        )

    try:
        run_no = int(run_no_raw)
    except (TypeError, ValueError):
        return json_error(
            "Query parameter 'run_no' must be a positive integer.",
            status_code=400,
            code="validation_error",
        )

    if run_no <= 0:
        return json_error(
            "Query parameter 'run_no' must be a positive integer.",
            status_code=400,
            code="validation_error",
        )

    params = request.args.to_dict(flat=True)
    params.pop("run_id", None)
    params["run_no"] = run_no

    try:
        resp = requests.get(url, params=params, timeout=30)
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


# ---------------------------------------------------------------------------
# UI entrypoint (dashboard)
# ---------------------------------------------------------------------------


@app.get("/ui")
def ui_home():
    """Dashboard UI entrypoint (served by Brain; calls /api/* which proxy to CC3)."""
    return render_template("home.html")


# ---------------------------------------------------------------------------
# UI stubs required by templates/_layout.html navigation
# ---------------------------------------------------------------------------


@app.get("/build", endpoint="build")
def build_page():
    return redirect(url_for("ui_home"))


@app.get("/fix", endpoint="fix")
def fix_page():
    return redirect(url_for("ui_home"))


@app.get("/know", endpoint="know")
def know_page():
    return redirect(url_for("ui_home"))


@app.get("/roster", endpoint="roster_page")
def roster_page():
    return redirect(url_for("ui_home"))


if __name__ == "__main__":  # pragma: no cover
    # Local dev convenience; in production Render will run via gunicorn.
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5055")), debug=True)
