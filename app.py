import json
import os
import threading
import time
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any, Dict, Iterable, List, Optional, Tuple

import requests
from sqlalchemy import bindparam, create_engine, inspect, text
from sqlalchemy.engine import Engine
from flask import (
    Flask,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from dotenv import load_dotenv

from services import api_contract
from services.query_params import normalize_airline_query

# SCHEMA RULE:
# - 'airline' is canonical
# - new query param names require a CWO
# - Brain rejects unknown params to prevent drift

# EWOT: This app is a thin proxy between The Brain frontend and the
# CodeCrafter2 Ops API. It exposes /api/* endpoints that forward to CC2
# and returns JSON, so the React frontend never sees HTML 404s.

# Load environment variables (including CC2_UPSTREAM_BASE)
load_dotenv()

app = Flask(__name__)
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-not-secret")

# --- CORS (Render frontend -> Render backend) ---
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "https://brain-6ufd.onrender.com")


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = FRONTEND_ORIGIN
    resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Credentials"] = "true"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return resp


@app.route("/api/<path:_any>", methods=["OPTIONS"])
def cors_preflight(_any):
    # Respond to browser preflight requests cleanly
    return ("", 204)

# --- Contract Guard: prevent schema drift by rejecting unknown query params ---

ALLOWED_QUERY_PARAMS = {
    # Core ops endpoints
    "api_flights": {"date", "airport", "airline", "airlines", "operator", "limit"},  # operator accepted as legacy alias
    "api_runs": {"date", "airport", "airline", "airlines", "operator", "shift"},     # operator accepted as legacy alias
    "api_metrics_jq_departures": {"date", "airport", "airline", "start_local", "end_local"},

    # Add more routes here as you harden them over time
    # "api_staff": {...},
    # "api_wiring_status": set(),
}


def _reject_unknown_query_params(route_key: str, allowed: set[str]):
    """
    EWOT: Validates request.args against a canonical allowlist to prevent schema drift.
    Returns a Flask response (json_error) if unknown params exist, else None.
    """
    try:
        provided = {k for k in request.args.keys()}
    except Exception:
        provided = set()

    unknown = sorted([k for k in provided if k not in allowed])
    if unknown:
        # Loud + explicit: fail fast, do not silently accept drift.
        msg = f"Unknown query parameter(s): {', '.join(unknown)}. Allowed: {', '.join(sorted(allowed))}"
        app.logger.warning("schema_drift route=%s unknown=%s", route_key, unknown)
        return json_error(msg, status_code=400, code="schema_drift")

    return None

# ---------------------------------------------------------------------------
# Jinja helpers required by templates/_layout.html
# ---------------------------------------------------------------------------


def get_current_role() -> str:
    """Return the current UI role for template gating.

    Defaults to ``viewer`` but allows quick local overrides via ``?role=admin``
    or ``?role=supervisor`` in the query string to mirror the navigation
    expectations in ``templates/_layout.html``.
    """

    role = (request.args.get("role") or "").strip().lower()
    if role in {"admin", "supervisor"}:
        return role

    return "viewer"


# Expose as a Jinja global so templates can call get_current_role()
app.jinja_env.globals["get_current_role"] = get_current_role


# Ensure current_role is always present in template context
@app.context_processor
def inject_current_role():
    return {"current_role": get_current_role()}

def _env_flag(name: str, default: str = "false") -> bool:
    return os.getenv(name, default).lower() in {"1", "true", "yes", "on"}

_DB_ENGINE: Optional[Engine] = None


def _normalize_database_url(uri: str) -> str:
    if uri.startswith("postgres://"):
        return uri.replace("postgres://", "postgresql://", 1)
    return uri


def _get_db_engine() -> Optional[Engine]:
    global _DB_ENGINE

    if _DB_ENGINE is not None:
        return _DB_ENGINE

    uri = os.getenv("DATABASE_URL")
    if not uri:
        return None

    _DB_ENGINE = create_engine(_normalize_database_url(uri), future=True)
    return _DB_ENGINE


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

CC3_INGEST_BASE_URL = (
    os.getenv("CC3_INGEST_BASE_URL")
    or os.getenv("OPS_API_BASE")
    or DEFAULT_CC3_UPSTREAM_BASE
).strip()
CC3_INGEST_CANARY_TIMEOUT_SEC = float(
    os.getenv("CC3_INGEST_CANARY_TIMEOUT_SEC", "8")
)

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
        self.configured_base = (configured_base or "").strip().rstrip("/")
        self.candidates = _CANDIDATE_BASE_URLS
        self.ttl_seconds = max(ttl_minutes, 1) * 60
        self._lock = threading.Lock()
        self._last_probe_at: Optional[float] = None
        # Always have a sane default base if env-configured base is empty
        default_base = self.configured_base or (self.candidates[0] if self.candidates else "")
        self._active_base: str = default_base
        self._last_canary_result: Dict[str, Any] = {}

        # prevent request threads blocking on probes
        self._probe_inflight = False

        # tuneable probe timeout (keep it short)
        self._probe_timeout_sec = float(os.getenv("UPSTREAM_PROBE_TIMEOUT_SEC", "6.0"))

    def _needs_refresh(self) -> bool:
        if self._last_probe_at is None:
            return True
        return (time.monotonic() - self._last_probe_at) > self.ttl_seconds

    def _probe_candidates(self) -> str:
        """
        EWOT: Probe upstream base URLs quickly and select the first that returns a 200
        from /api/health (lightweight liveness check).
        """
        self._last_probe_at = time.monotonic()

        attempts: List[Dict[str, Any]] = []
        chosen_base = self._active_base or self.configured_base or (self.candidates[0] if self.candidates else "")
        found_working = False

        for base_url in self.candidates:
            base_url = (base_url or "").rstrip("/")
            probe_url = f"{base_url}/api/health"

            attempt: Dict[str, Any] = {"base_url": base_url}
            ok = False
            payload: Dict[str, Any] = {}

            start_attempt = time.monotonic()
            try:
                resp = requests.get(
                    probe_url,
                    timeout=self._probe_timeout_sec,
                )
                attempt["status"] = resp.status_code

                try:
                    payload = resp.json() if resp is not None else {}
                except Exception:
                    payload = {}

                attempt["response_ok"] = isinstance(payload, dict)
                ok = resp.status_code == 200

            except requests.RequestException as exc:
                attempt["error"] = str(exc)
            except Exception as exc:  # noqa: BLE001
                attempt["error"] = str(exc)
            finally:
                attempt["elapsed_seconds"] = round(time.monotonic() - start_attempt, 4)

            attempt["ok"] = ok
            attempts.append(attempt)

            if ok:
                chosen_base = base_url
                found_working = True
                break

        self._active_base = chosen_base
        self._last_canary_result = {
            "ok": found_working,
            "selected_base_url": chosen_base,
            "attempts": attempts,
            "canary_timeout_seconds": self._probe_timeout_sec,
            "at": datetime.now(timezone.utc).isoformat(),
        }

        return self._active_base

    def _probe_wrapper(self) -> None:
        try:
            with self._lock:
                if not self._needs_refresh():
                    return
            # probe without holding lock
            new_base = self._probe_candidates()
            with self._lock:
                self._active_base = new_base
        finally:
            with self._lock:
                self._probe_inflight = False

    def get_active_base(self) -> str:
        with self._lock:
            current = self._active_base or self.configured_base

            if not self._needs_refresh():
                return current

            if not self._probe_inflight:
                self._probe_inflight = True
                t = threading.Thread(target=self._probe_wrapper, daemon=True)
                t.start()

            # do not block the caller
            return current

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


def _cc3_ingest_base() -> str:
    return (CC3_INGEST_BASE_URL or DEFAULT_CC3_UPSTREAM_BASE).rstrip("/")


def _normalize_flight_sample(sample: Any) -> List[str]:
    if isinstance(sample, list):
        return [str(item) for item in sample if item is not None]
    if sample is None:
        return []
    return [str(sample)]


def _sydney_tomorrow_iso() -> str:
    tz = ZoneInfo("Australia/Sydney")
    return (datetime.now(tz) + timedelta(days=1)).date().isoformat()


def _sydney_today_iso() -> str:
    tz = ZoneInfo("Australia/Sydney")
    return datetime.now(tz).date().isoformat()


def _normalize_db_date(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        return value[:10]
    return str(value)


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

    def _maps_to_candidates(
        endpoint_name: str,
        fallback: Iterable[str],
        *,
        include_airport: bool = False,
    ) -> List[str]:
        airport = os.getenv("DEFAULT_AIRPORT", "YSSY")

        for endpoint in contract.get("endpoints", []):
            if endpoint.get("name") == endpoint_name:
                maps_to = endpoint.get("maps_to") or []
                if isinstance(maps_to, list) and maps_to:
                    return [
                        f"{path}?date={sample_date}&airline=ALL"
                        f"{'&airport=' + airport if include_airport else ''}"
                        for path in maps_to
                    ]
        return [
            f"{path}?date={sample_date}&airline=ALL"
            f"{'&airport=' + airport if include_airport else ''}"
            for path in fallback
        ]

    flights_candidates = _maps_to_candidates(
        "flights_daily",
        [
            "/api/flights",
            "/api/ops/flights",
            "/api/ops/schedule/flights",
        ],
    )

    runs_candidates = _maps_to_candidates(
        "runs",
        [
            "/api/runs",
            "/api/ops/runs/daily",
            "/api/ops/schedule/runs/daily",
        ],
        include_airport=True,
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


def _require_airport_field(payload: Dict[str, Any]) -> Tuple[Optional[str], Optional[Tuple[Any, int]]]:
    airport = str(payload.get("airport") or "").strip().upper()
    if not airport:
        return None, json_error(
            "airport is required",
            status_code=400,
            code="validation_error",
        )
    return airport, None


def _normalize_airline_param(
    airline: Optional[str],
    operator: Optional[str],
    *,
    default: str = "ALL",
) -> Tuple[Optional[str], Optional[Tuple[Any, int]]]:
    airline_raw = str(airline or "").strip()
    operator_raw = str(operator or "").strip()

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


def _flight_airline_code(f: Dict[str, Any]) -> Optional[str]:
    """
    EWOT: Extract an airline code from various upstream schemas.
    """
    code = _pick_first(
        f.get("airline_code"),
        f.get("airline"),
        f.get("operator_code"),
        f.get("operator"),
    )
    if code is None:
        # last-ditch: infer from flight number prefix (e.g., JQ503 -> JQ)
        fn = str(_pick_first(f.get("flight_number"), f.get("ident_iata"), f.get("ident")) or "").strip().upper()
        if len(fn) >= 2 and fn[:2].isalpha():
            code = fn[:2]
    try:
        text = str(code or "").strip().upper()
        return text or None
    except Exception:  # noqa: BLE001
        return None


def _normalize_flight_for_ui(f: Dict[str, Any]) -> Dict[str, Any]:
    """
    EWOT: Convert upstream flight record into the Brain UI Flight shape.
    """
    flight_number = str(_pick_first(f.get("flight_number"), f.get("ident_iata"), f.get("ident")) or "").strip().upper()
    origin = str(_pick_first(f.get("origin"), f.get("origin_iata")) or "").strip().upper()
    destination = str(_pick_first(f.get("destination"), f.get("dest"), f.get("destination_iata")) or "").strip().upper()

    # time_local (HH:MM) is what the UI uses in tables
    time_local = _pick_first(
        f.get("time_local"),
        f.get("etd_local"),
        f.get("dep_time"),
        _extract_local_hhmm(_pick_first(f.get("scheduled_off"), f.get("estimated_off"), f.get("time_iso"), f.get("time"))),
    )
    # if we got an ISO string, try to keep HH:MM
    hhmm = _extract_local_hhmm(time_local) if isinstance(time_local, str) else None

    airline_code = _flight_airline_code(f)

    return {
        "id": _pick_first(f.get("id"), f.get("fa_flight_id")),
        "flight_number": flight_number or None,
        "destination": destination or None,
        "origin": origin or None,
        "time_local": hhmm,
        # Canonical field going forward:
        "airline_code": airline_code,
        # Back-compat for any older UI bits that still read operator_code:
        "operator_code": airline_code,
    }


def _default_airport() -> str:
    return (os.getenv("DEFAULT_AIRPORT", "YSSY") or "YSSY").strip().upper()


def _mock_staff_enabled() -> bool:
    return _env_flag("BRAIN_MOCK_STAFF")


def _pick_first(*values: Optional[Any]) -> Optional[Any]:
    for value in values:
        if value is None:
            continue
        text = str(value).strip()
        if text:
            return value
    return None


def _extract_local_hhmm(value: Optional[Any]) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        raw = value.strip()
        if len(raw) >= 5 and raw[2] == ":":
            return raw[:5]
        try:
            iso_value = raw.replace("Z", "+00:00")
            dt = datetime.fromisoformat(iso_value)
            return dt.strftime("%H:%M")
        except ValueError:
            return None
    return None


def _parse_iso_datetime(value: Optional[Any]) -> Optional[datetime]:
    if value is None:
        return None
    if not isinstance(value, str):
        value = str(value)
    raw = value.strip()
    if not raw:
        return None
    try:
        iso_value = raw.replace("Z", "+00:00")
        dt = datetime.fromisoformat(iso_value)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _parse_hhmm_with_offset(
    value: Optional[str],
    *,
    label: str,
    allow_24: bool = False,
) -> Tuple[Optional[Tuple[int, int, int]], Optional[Tuple[Any, int]]]:
    text = (value or "").strip()
    if not text:
        return None, json_error(
            f"Missing required '{label}' query parameter.",
            status_code=400,
            code="validation_error",
        )
    parts = text.split(":")
    if len(parts) != 2:
        return None, json_error(
            f"Invalid {label} value '{text}'. Expected HH:MM.",
            status_code=400,
            code="validation_error",
        )
    try:
        hours = int(parts[0])
        minutes = int(parts[1])
    except ValueError:
        return None, json_error(
            f"Invalid {label} value '{text}'. Expected HH:MM.",
            status_code=400,
            code="validation_error",
        )
    if minutes < 0 or minutes > 59:
        return None, json_error(
            f"Invalid {label} value '{text}'. Expected HH:MM.",
            status_code=400,
            code="validation_error",
        )
    if hours == 24 and minutes == 0:
        if not allow_24:
            return None, json_error(
                f"Invalid {label} value '{text}'. Expected HH:MM.",
                status_code=400,
                code="validation_error",
            )
        return (0, 0, 1), None
    if hours < 0 or hours > 23:
        return None, json_error(
            f"Invalid {label} value '{text}'. Expected HH:MM.",
            status_code=400,
            code="validation_error",
        )
    return (hours, minutes, 0), None


def _time_to_minutes(hhmm: Optional[str]) -> Optional[int]:
    if not hhmm:
        return None
    try:
        parts = hhmm.split(":")
        return int(parts[0]) * 60 + int(parts[1])
    except (ValueError, IndexError, TypeError):
        return None


def _extract_flights_list(payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [f for f in payload if isinstance(f, dict)]
    if not isinstance(payload, dict):
        return []
    candidates = [
        payload.get("records"),
        payload.get("rows"),
        payload.get("flights"),
        payload.get("items"),
        payload.get("data"),
    ]
    for candidate in candidates:
        if isinstance(candidate, list):
            return [f for f in candidate if isinstance(f, dict)]
    return []


def _extract_airline_code(flight: Dict[str, Any]) -> str:
    if not isinstance(flight, dict):
        return ""
    for key in (
        "airline",
        "airline_iata",
        "airline_code",
        "operator",
        "operator_iata",
        "operator_code",
    ):
        value = flight.get(key)
        if value:
            return str(value).strip().upper()
    return ""


def _canonicalize_flight(flight: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(flight, dict):
        return flight
    airline = _extract_airline_code(flight)
    normalized = dict(flight)
    if airline:
        normalized["airline"] = airline
    for key in ("operator", "operator_iata", "operator_code"):
        normalized.pop(key, None)
    return normalized


def _build_mock_roster(date_str: str, airport: str) -> List[Dict[str, Any]]:
    shifts = []
    for idx in range(8):
        staff_id = 1001 + idx
        staff_code = f"S{idx + 1:02d}"
        staff_name = f"Staff {idx + 1:02d}"
        is_am = idx < 4
        shifts.append(
            {
                "staff_id": staff_id,
                "staff_code": staff_code,
                "staff_name": staff_name,
                "employment_type": "FT" if idx < 5 else "PT",
                "start_local": "05:00" if is_am else "12:00",
                "end_local": "13:00" if is_am else "20:00",
                "role": "Ramp",
            }
        )
    return shifts


def _staff_seed_path() -> str:
    base_dir = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base_dir, "data", "staff_seed.json")


def _load_staff_seed() -> List[Dict[str, Any]]:
    try:
        with open(_staff_seed_path(), "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return []
    except Exception:  # noqa: BLE001
        return []

    if isinstance(payload, list):
        return [entry for entry in payload if isinstance(entry, dict)]
    return []


def _normalize_shift_param(value: Optional[str]) -> str:
    text = (value or "ALL").strip().upper()
    return text or "ALL"


def _staff_for_shift(staff: List[Dict[str, Any]], shift: str) -> List[Dict[str, Any]]:
    if shift == "ALL":
        return staff
    filtered = []
    for entry in staff:
        entry_shift = str(entry.get("shift") or "").strip().upper()
        if entry_shift == shift:
            filtered.append(entry)
    return filtered


def _flight_sort_key(flight: Dict[str, Any]) -> Tuple[int, str]:
    time_value = _pick_first(
        flight.get("scheduled_off"),
        flight.get("estimated_off"),
        flight.get("time_iso"),
        flight.get("time"),
        flight.get("dep_time"),
        flight.get("time_local"),
        flight.get("timeLocal"),
    )
    minutes = _time_to_minutes(_extract_local_hhmm(time_value))
    sortable_minutes = minutes if minutes is not None else 24 * 60 + 1
    ident = str(
        _pick_first(
            flight.get("ident"),
            flight.get("ident_iata"),
            flight.get("flight_number"),
            flight.get("flightNumber"),
            flight.get("id"),
        )
        or ""
    )
    return sortable_minutes, ident


def _build_assignments_for_flights(
    flights: List[Dict[str, Any]],
    staff: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    if not flights:
        return []
    if not staff:
        return []

    sorted_flights = sorted(flights, key=_flight_sort_key)
    assignments = []
    for idx, flight in enumerate(sorted_flights):
        staff_entry = staff[idx % len(staff)]
        assignments.append(
            {
                **flight,
                "staff_id": staff_entry.get("staff_id"),
                "staff_name": staff_entry.get("staff_name"),
                "staff_code": staff_entry.get("staff_code"),
                "assigned_staff_id": staff_entry.get("staff_id"),
                "assigned_staff_name": staff_entry.get("staff_name"),
                "assigned_staff_code": staff_entry.get("staff_code"),
                "assigned_staff_role": staff_entry.get("role"),
            }
        )
    return assignments


def _build_runs_from_assignments(
    assignments: List[Dict[str, Any]],
    staff: List[Dict[str, Any]],
    *,
    shift_requested: str,
) -> List[Dict[str, Any]]:
    if not assignments:
        return []

    staff_index = {entry.get("staff_id"): entry for entry in staff}
    runs_by_staff: Dict[Any, Dict[str, Any]] = {}

    for assignment in assignments:
        staff_id = assignment.get("assigned_staff_id")
        if staff_id is None:
            continue
        if staff_id not in runs_by_staff:
            staff_entry = staff_index.get(staff_id, {})
            runs_by_staff[staff_id] = {
                "run_id": staff_id,
                "run_no": staff_id,
                "staff_id": staff_id,
                "staff_name": staff_entry.get("staff_name"),
                "staff_code": staff_entry.get("staff_code"),
                "staff_role": staff_entry.get("role"),
                "shift": shift_requested,
                "shift_start": staff_entry.get("shift_start"),
                "shift_end": staff_entry.get("shift_end"),
                "flights": [],
            }
        runs_by_staff[staff_id]["flights"].append(assignment)

    return list(runs_by_staff.values())


def _flight_to_job(flight: Dict[str, Any]) -> Dict[str, Any]:
    flight_id = _pick_first(
        flight.get("flight_id"),
        flight.get("id"),
        flight.get("fa_flight_id"),
    )
    flight_number = _pick_first(
        flight.get("flight_number"),
        flight.get("flightNumber"),
        flight.get("ident_iata"),
        flight.get("ident"),
    )
    dest = _pick_first(
        flight.get("dest"),
        flight.get("destination"),
        flight.get("destination_iata"),
        flight.get("arrival_airport"),
    )
    etd = _pick_first(
        flight.get("etd_local"),
        flight.get("time_local"),
        flight.get("timeLocal"),
        flight.get("time"),
        flight.get("dep_time"),
        flight.get("estimated_off"),
        flight.get("scheduled_off"),
        flight.get("time_iso"),
    )
    etd_local = _extract_local_hhmm(etd) or (str(etd).strip() if etd else None)
    return {
        "flight_id": flight_id,
        "flight_number": flight_number,
        "dest": dest,
        "etd_local": etd_local,
    }


def _build_mock_staff_runs(
    flights: List[Dict[str, Any]], roster: List[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    staff_ids = [shift.get("staff_id") for shift in roster if shift.get("staff_id") is not None]
    staff_runs = []
    run_map: Dict[int, Dict[str, Any]] = {}
    for idx, shift in enumerate(roster):
        staff_id = shift.get("staff_id")
        if staff_id is None:
            continue
        run = {
            "id": 5001 + idx,
            "staff_id": staff_id,
            "staff_code": shift.get("staff_code"),
            "staff_name": shift.get("staff_name"),
            "shift_start": shift.get("start_local"),
            "shift_end": shift.get("end_local"),
            "jobs": [],
        }
        run_map[staff_id] = run
        staff_runs.append(run)

    unassigned: List[Dict[str, Any]] = []
    sorted_flights = []
    for idx, flight in enumerate(flights):
        job = _flight_to_job(flight)
        sort_time = _time_to_minutes(_extract_local_hhmm(job.get("etd_local")))
        sorted_flights.append((sort_time, idx, flight, job))
    sorted_flights.sort(key=lambda item: (item[0] is None, item[0], item[1]))

    for idx, (_, _, flight, job) in enumerate(sorted_flights):
        if not job.get("flight_number"):
            unassigned.append({**job, "reason": "missing flight number"})
            continue
        if not job.get("etd_local"):
            unassigned.append({**job, "reason": "missing ETD"})
            continue
        if not staff_ids:
            unassigned.append({**job, "reason": "no roster staff"})
            continue
        staff_id = staff_ids[idx % len(staff_ids)]
        run = run_map.get(staff_id)
        if not run:
            unassigned.append({**job, "reason": "staff not found"})
            continue
        job["sequence"] = len(run["jobs"]) + 1
        run["jobs"].append(job)

    return staff_runs, unassigned


def _fetch_flights_for_assignment(
    *,
    date_str: str,
    airport: str,
    airline: str,
) -> List[Dict[str, Any]]:
    # Fetch wide (no airline filter), then filter locally.
    flights_paths = [
        "/api/ops/schedule/flights",
        "/api/ops/flights",
        "/api/flights",
    ]
    params = {
        "date": date_str,
        "airline": "ALL",
        "airport": airport,
    }

    try:
        resp, _ = _call_upstream(flights_paths, params=params, timeout=20)
    except requests.RequestException:
        return []

    if resp is None or resp.status_code == 404:
        return []

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return []

    flights = _extract_flights_list(payload)
    wanted = []
    a = (airline or "ALL").strip().upper()
    if a and a != "ALL":
        wanted = [a]
    if not wanted:
        return flights
    out = []
    for f in flights:
        code = _flight_airline_code(f)
        if code and code in wanted:
            out.append(f)
    return out

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


@app.get("/api/cc3/ingest_canary")
def api_cc3_ingest_canary():
    """Trigger a CC3 ingest canary run with a short timeout."""
    date_str = request.args.get("date") or datetime.now(timezone.utc).date().isoformat()
    airport = request.args.get("airport") or os.getenv("DEFAULT_AIRPORT", "YSSY")
    base_url = _cc3_ingest_base()

    if not base_url:
        return json_error(
            "No CC3 ingest base URL configured.",
            status_code=500,
            code="cc3_base_missing",
        )

    canary_url = f"{base_url}/api/ingest/canary"
    try:
        resp = requests.get(
            canary_url,
            params={"date": date_str, "airport": airport},
            timeout=CC3_INGEST_CANARY_TIMEOUT_SEC,
        )
    except requests.RequestException as exc:
        return json_error(
            "CC3 ingest canary request failed.",
            status_code=502,
            code="cc3_canary_unreachable",
            detail={"message": str(exc), "cc3_base_url": base_url},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        payload = {}

    if not resp.ok or not isinstance(payload, dict):
        detail = {"status": resp.status_code, "cc3_base_url": base_url}
        if isinstance(payload, dict) and payload:
            detail["response"] = payload
        return json_error(
            "CC3 ingest canary returned an invalid response.",
            status_code=502,
            code="cc3_canary_invalid",
            detail=detail,
        )

    result_source = payload.get("canary_result")
    if not isinstance(result_source, dict):
        result_source = payload

    count_value = result_source.get("count")
    sample_value = _normalize_flight_sample(
        result_source.get("flight_numbers_sample")
        or result_source.get("flight_numbers")
    )

    reasons: List[str] = []
    count_int: Optional[int] = None
    if count_value is None:
        reasons.append("No count returned.")
    else:
        try:
            count_int = int(count_value)
            if count_int <= 15:
                reasons.append("Count is 15 or less.")
        except (TypeError, ValueError):
            reasons.append("Count is not numeric.")

    if len(sample_value) == 0:
        reasons.append("No flight numbers sample.")

    status_ok = len(reasons) == 0

    return _build_ok(
        {
            "cc3_base_url": base_url,
            "canary_request": {"date": date_str, "airport": airport},
            "canary_result": {
                "count": count_int if count_int is not None else count_value,
                "flight_numbers_sample": sample_value,
            },
            "status": {
                "ok": status_ok,
                "label": "PASS" if status_ok else "FAIL",
                "reasons": reasons,
            },
        }
    )


@app.route("/api/machine-room/cc3-ingest-canary", methods=["GET", "POST"])
def api_machine_room_cc3_ingest_canary():
    """Run a CC3 ingest canary for Machine Room with safe defaults."""
    airport = "YSSY"
    scope = "both"
    store = False
    timeout_sec = 8
    date_str = _sydney_today_iso()

    canary_request = {
        "airport": airport,
        "date": date_str,
        "timeout": timeout_sec,
        "store": store,
        "scope": scope,
    }

    active_base = _active_upstream_base()
    cc3_base_url = active_base.rstrip("/") if active_base else None
    reasons: List[str] = []
    if not cc3_base_url:
        reasons.append("No upstream base URL configured.")

    try:
        resp = None
        upstream_payload = None
        if cc3_base_url:
            resp = requests.post(
                f"{cc3_base_url}/api/flights/ingest/aeroapi",
                json=canary_request,
                timeout=timeout_sec,
            )
            try:
                upstream_payload = resp.json()
            except Exception:  # noqa: BLE001
                upstream_payload = None
    except requests.Timeout:
        reasons.append("Upstream request timed out.")
    except requests.RequestException as exc:
        reasons.append(f"Upstream request failed: {exc}")

    if resp is not None and not resp.ok:
        reason = f"Upstream returned HTTP {resp.status_code}."
        if isinstance(upstream_payload, dict):
            message = upstream_payload.get("error") or upstream_payload.get("message")
            if message:
                reason = f"{reason} {message}"
        reasons.append(reason)

    if resp is not None and upstream_payload is None:
        reasons.append("Upstream returned invalid JSON.")

    result_source = None
    if isinstance(upstream_payload, dict):
        result_source = upstream_payload.get("canary_result")
        if not isinstance(result_source, dict):
            result_source = upstream_payload

    count_value = result_source.get("count") if isinstance(result_source, dict) else None
    sample_value = (
        result_source.get("flight_numbers_sample")
        or result_source.get("flight_numbers")
        if isinstance(result_source, dict)
        else None
    )
    normalized_sample = _normalize_flight_sample(sample_value)
    non_empty_sample = [
        value.strip() for value in normalized_sample if value and value.strip()
    ]

    count_int: Optional[int] = None
    if count_value is None:
        reasons.append("No count returned.")
    else:
        try:
            count_int = int(count_value)
            if count_int <= 15:
                reasons.append("Count is 15 or less.")
        except (TypeError, ValueError):
            reasons.append("Count is not numeric.")

    if not non_empty_sample:
        reasons.append("No non-empty flight numbers sample.")

    upstream_ok = upstream_payload.get("ok") if isinstance(upstream_payload, dict) else None
    if resp is not None and upstream_ok is False:
        message = (
            upstream_payload.get("error") or upstream_payload.get("message")
            if isinstance(upstream_payload, dict)
            else None
        )
        reasons.append(message or "Upstream response ok!=true.")

    status = "PASS" if len(reasons) == 0 else "FAIL"
    canary_result = {
        "ok": upstream_ok is True,
        "count": count_int if count_int is not None else count_value,
        "flight_numbers_sample": non_empty_sample,
    }

    return _build_ok(
        {
            "status": status,
            "cc3_base_url": cc3_base_url,
            "canary_request": canary_request,
            "canary_result": canary_result,
            "reasons": reasons,
        }
    )


@app.get("/api/machine-room/db-flight-inventory")
def api_machine_room_db_flight_inventory():
    """Return counts of flights stored in the Brain DB for a date range."""
    airport = (request.args.get("airport") or "").strip().upper()
    if not airport:
        return jsonify({"ok": False, "error": "airport is required"}), 400

    start_raw = (request.args.get("start") or "").strip()
    if start_raw:
        try:
            start_date = datetime.strptime(start_raw, "%Y-%m-%d").date()
        except ValueError:
            return jsonify({"ok": False, "error": "start must be in YYYY-MM-DD format"}), 400
    else:
        start_raw = _sydney_today_iso()
        start_date = datetime.strptime(start_raw, "%Y-%m-%d").date()

    days_raw = request.args.get("days")
    try:
        days = int(days_raw) if days_raw is not None else 4
    except (TypeError, ValueError):
        days = 4
    days = max(1, min(days, 14))

    airlines_raw = (
        request.args.get("airlines")
        or request.args.get("airline")
        or request.args.get("operator")
        or ""
    ).strip()
    if not airlines_raw:
        airlines_raw = "ALL"

    airlines_list: List[str] = []
    if airlines_raw.upper() not in {"ALL", "*"}:
        airlines_list = _parse_airlines_csv(airlines_raw)
    airlines_selected = airlines_list if airlines_list else ["ALL"]

    engine = _get_db_engine()
    if engine is None:
        return jsonify({"ok": False, "error": "DATABASE_URL is not set"}), 500

    try:
        inspector = inspect(engine)
        if "flights" not in inspector.get_table_names():
            return jsonify({"ok": False, "error": "flights table not found"}), 500

        columns = {col["name"] for col in inspector.get_columns("flights")}
        if "airport" not in columns:
            return jsonify({"ok": False, "error": "flights table missing airport column"}), 500

        airline_column_available = "airline" in columns
        if airlines_list and not airline_column_available:
            return (
                jsonify({"ok": False, "error": "airline filter unavailable (airline column missing)"}),
                500,
            )

        end_date = start_date + timedelta(days=days - 1)
        base_sql = (
            "FROM flights WHERE date BETWEEN :start AND :end AND airport = :airport"
        )
        params: Dict[str, Any] = {
            "start": start_date,
            "end": end_date,
            "airport": airport,
        }
        if airlines_list:
            base_sql += " AND airline IN :airlines"
            params["airlines"] = airlines_list

        total_sql = text(f"SELECT date, COUNT(*) AS count {base_sql} GROUP BY date")
        by_airline_sql = None
        if airline_column_available:
            by_airline_sql = text(
                f"SELECT date, airline, COUNT(*) AS count {base_sql} GROUP BY date, airline"
            )

        if airlines_list:
            total_sql = total_sql.bindparams(bindparam("airlines", expanding=True))
            if by_airline_sql is not None:
                by_airline_sql = by_airline_sql.bindparams(
                    bindparam("airlines", expanding=True)
                )

        totals: Dict[str, int] = {}
        by_airline_map: Dict[str, Dict[str, int]] = {}

        with engine.begin() as conn:
            for row in conn.execute(total_sql, params).mappings():
                date_key = _normalize_db_date(row.get("date"))
                if not date_key:
                    continue
                totals[date_key] = int(row.get("count") or 0)

            if by_airline_sql is not None:
                for row in conn.execute(by_airline_sql, params).mappings():
                    date_key = _normalize_db_date(row.get("date"))
                    airline_code = (row.get("airline") or "").strip().upper()
                    if not date_key or not airline_code:
                        continue
                    by_airline_map.setdefault(date_key, {})[airline_code] = int(
                        row.get("count") or 0
                    )

        days_payload = []
        for offset in range(days):
            day = start_date + timedelta(days=offset)
            date_str = day.isoformat()
            days_payload.append(
                {
                    "date": date_str,
                    "count": totals.get(date_str, 0),
                    "by_airline": by_airline_map.get(date_str, {})
                    if airline_column_available
                    else {},
                }
            )

        return jsonify(
            {
                "ok": True,
                "source": "db",
                "airport": airport,
                "airlines_selected": airlines_selected,
                "range": {"start": start_raw, "days": days},
                "days": days_payload,
                "note": "DB snapshot only (no upstream calls).",
            }
        ), 200
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("Failed to load DB flight inventory")
        return jsonify({"ok": False, "error": str(exc)}), 500


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
    """Non-blocking wiring-status. Returns cached upstream selection + last canary."""
    start_ts = time.monotonic()

    # Returns immediately (may kick off background probe if TTL expired)
    active_base = _active_upstream_base().rstrip("/")

    payload = {
        "ok": True,
        "source": "local",
        "upstream_base_url_configured": CONFIGURED_UPSTREAM_BASE_URL,
        "upstream_base_url_active": active_base,
        "last_upstream_canary": upstream_selector.last_canary_result,
        "metrics": {"duration_seconds": round(time.monotonic() - start_ts, 4)},
        "note": "Non-blocking wiring-status; upstream probes run asynchronously.",
    }
    return jsonify(payload), 200


@app.get("/api/wiring")
def api_wiring_snapshot():
    """Augmented wiring snapshot with route checks and config flags."""

    sample_date = datetime.now(timezone.utc).date().isoformat()
    route_checks = {
        "flights": _probe_route([
            "/api/flights",
            "/api/ops/flights",
            "/api/ops/schedule/flights",
        ], params={"date": sample_date, "airline": "ALL"}),
        "staff": _probe_route([
            "/api/staff",
            "/api/ops/staff",
        ]),
        "runs": _probe_route([
            "/api/runs",
            "/api/ops/runs/daily",
            "/api/ops/schedule/runs/daily",
        ], params={"date": sample_date, "airline": "ALL", "airport": os.getenv("DEFAULT_AIRPORT", "YSSY")}),
        "autoAssign": _probe_route([
            "/api/runs/auto_assign",
        ], method="post", json={"date": sample_date, "airline": "ALL"}),
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
def api_contract():
    return jsonify(
        {
            "ok": True,
            "available": False,
            "note": "contract endpoint not implemented; UI should treat as optional",
            "endpoints": [],
        }
    )


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


@app.get("/api/roster/daily")
def api_roster_daily():
    """Return roster shifts for the day (mocked when enabled)."""

    if (date_error := _require_date_param()) is not None:
        return date_error

    airport = (request.args.get("airport") or _default_airport()).strip().upper()
    date_str = request.args.get("date")

    if not _mock_staff_enabled():
        return json_error(
            "Roster daily endpoint not implemented.",
            status_code=501,
            code="not_implemented",
        )

    shifts = _build_mock_roster(date_str, airport)
    return _build_ok(
        {
            "date": date_str,
            "airport": airport,
            "source": "mock",
            "roster": {"shifts": shifts},
        }
    )


@app.get("/api/staff_runs")
def api_staff_runs():
    """Return staff runs for the day (mocked when enabled)."""

    if (date_error := _require_date_param()) is not None:
        return date_error

    airline, airline_err = normalize_airline_query(request.args)
    if airline_err is not None:
        return airline_err

    airport = (request.args.get("airport") or _default_airport()).strip().upper()
    date_str = request.args.get("date")

    if not _mock_staff_enabled():
        return json_error(
            "Staff runs endpoint not implemented.",
            status_code=501,
            code="not_implemented",
        )

    flights_paths = [
        "/api/ops/schedule/flights",
        "/api/ops/flights",
        "/api/flights",
    ]
    params = {
        "date": date_str,
        "airline": airline,
        "airport": airport,
    }

    flights: List[Dict[str, Any]] = []
    try:
        resp, _ = _call_upstream(flights_paths, params=params, timeout=20)
    except requests.RequestException:
        resp = None

    if resp is not None and resp.status_code != 404:
        try:
            payload = resp.json()
        except Exception:  # noqa: BLE001
            payload = None
        flights = _extract_flights_list(payload)

    roster = _build_mock_roster(date_str, airport)
    runs, unassigned = _build_mock_staff_runs(flights, roster)

    return _build_ok(
        {
            "date": date_str,
            "airport": airport,
            "airline": airline,
            "source": "mock",
            "runs": runs,
            "unassigned": unassigned,
        }
    )


@app.get("/api/flights")
def api_flights():
    """Proxy GET /api/flights with legacy compatibility fallbacks."""
    guard = _reject_unknown_query_params("api_flights", ALLOWED_QUERY_PARAMS["api_flights"])
    if guard is not None:
        return guard

    if (date_error := _require_date_param()) is not None:
        return date_error

    airlines_csv = request.args.get("airlines") or ""
    airlines_requested = bool(airlines_csv.strip())
    airlines_list = _parse_airlines_csv(airlines_csv) if airlines_requested else []
    if airlines_csv.strip().upper() == "ALL":
        airlines_list = []
    if airlines_requested:
        airline = "ALL"
    else:
        airline, airline_err = _normalize_airline_param(
            request.args.get("airline"),
            request.args.get("operator"),
        )
        if airline_err is not None:
            return airline_err
    airport = (request.args.get("airport") or "").strip().upper()

    if not airport:
        return json_error(
            "Missing required 'airport' query parameter.",
            status_code=400,
            code="validation_error",
        )

    # Option 1: Fetch wide, filter in Brain.
    # Upstream CC3 DB read is once per request (date+airport), then we filter locally.
    params = {"date": request.args.get("date"), "airport": airport, "airline": airline}

    flights_paths = [
        "/api/ops/schedule/flights",
        "/api/ops/flights",
        "/api/flights",
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
        return _build_ok({"flights": [], "source": "compatibility", "upstream_path": used_path, "count": 0})

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return json_error(
            "Invalid JSON from flights backend.",
            status_code=502,
            code="invalid_json",
            detail={"raw": resp.text[:500]},
        )

    raw_flights = _extract_flights_list(payload)
    ui_flights = [_normalize_flight_for_ui(f) for f in raw_flights]

    if airlines_list:
        ui_flights = [f for f in ui_flights if (f.get("airline_code") in airlines_list)]
    elif airline and airline != "ALL":
        ui_flights = [f for f in ui_flights if (f.get("airline_code") == airline)]

    source = "upstream"
    if isinstance(payload, dict) and payload.get("source"):
        source = str(payload.get("source"))

    return jsonify(
        {
            "ok": True,
            "date": str(request.args.get("date") or "").strip(),
            "airport": airport,
            "airline": airline,
            "airlines_selected": airlines_list if airlines_list else ["ALL"],
            "source": source,
            "upstream_path": used_path,
            "count": len(ui_flights),
            "flights": ui_flights,
        }
    ), 200


@app.get("/api/metrics/jq_departures")
def api_metrics_jq_departures():
    """Return count of JQ departures within a Sydney-local time window."""
    guard = _reject_unknown_query_params(
        "api_metrics_jq_departures",
        ALLOWED_QUERY_PARAMS["api_metrics_jq_departures"],
    )
    if guard is not None:
        return guard

    date_str = (request.args.get("date") or "").strip()
    if not date_str:
        return json_error(
            "Missing required 'date' query parameter.",
            status_code=400,
            code="validation_error",
        )

    airport = (request.args.get("airport") or "").strip().upper()
    if not airport:
        return json_error(
            "Missing required 'airport' query parameter.",
            status_code=400,
            code="validation_error",
        )

    airline = (request.args.get("airline") or "JQ").strip().upper() or "JQ"
    start_local = (request.args.get("start_local") or "05:00").strip()
    end_local = (request.args.get("end_local") or "24:00").strip()

    try:
        local_date = datetime.fromisoformat(date_str).date()
    except ValueError:
        return json_error(
            "date must be in YYYY-MM-DD format",
            status_code=400,
            code="validation_error",
        )

    start_parts, start_err = _parse_hhmm_with_offset(
        start_local,
        label="start_local",
        allow_24=False,
    )
    if start_err is not None:
        return start_err

    end_parts, end_err = _parse_hhmm_with_offset(
        end_local,
        label="end_local",
        allow_24=True,
    )
    if end_err is not None:
        return end_err

    tz = ZoneInfo("Australia/Sydney")
    start_hour, start_min, start_offset = start_parts or (5, 0, 0)
    end_hour, end_min, end_offset = end_parts or (0, 0, 1)

    start_dt = datetime(
        local_date.year,
        local_date.month,
        local_date.day,
        start_hour,
        start_min,
        tzinfo=tz,
    ) + timedelta(days=start_offset)
    end_dt = datetime(
        local_date.year,
        local_date.month,
        local_date.day,
        end_hour,
        end_min,
        tzinfo=tz,
    ) + timedelta(days=end_offset)

    flights_paths = [
        "/api/ops/schedule/flights",
        "/api/ops/flights",
        "/api/flights",
    ]
    params = {
        "date": date_str,
        "airport": airport,
        "airline": airline,
    }

    try:
        resp, used_path = _call_upstream(flights_paths, params=params, timeout=20)
    except requests.RequestException as exc:
        app.logger.exception("Failed to call flights endpoint for metrics")
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
        return _build_ok(
            {
                "airport": airport,
                "local_date": date_str,
                "timezone": "Australia/Sydney",
                "airline": airline,
                "window_local": {"start": start_local, "end": end_local},
                "count": 0,
                "flights": [],
                "upstream_path": used_path,
                "source": "compatibility",
            }
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return json_error(
            "Invalid JSON from flights backend.",
            status_code=502,
            code="invalid_json",
            detail={"raw": resp.text[:500]},
        )

    raw_flights = _extract_flights_list(payload)
    matched: List[Dict[str, Any]] = []

    for flight in raw_flights:
        if not isinstance(flight, dict):
            continue
        if airline and airline != "ALL":
            flight_airline = _flight_airline_code(flight)
            if flight_airline != airline:
                continue
        off_value = _pick_first(flight.get("estimated_off"), flight.get("scheduled_off"))
        off_dt = _parse_iso_datetime(off_value)
        if off_dt is None:
            continue
        off_local = off_dt.astimezone(tz)
        if not (start_dt <= off_local < end_dt):
            continue
        summary = _normalize_flight_for_ui(flight)
        summary["off_local"] = off_local.strftime("%H:%M")
        matched.append(summary)

    return _build_ok(
        {
            "airport": airport,
            "local_date": date_str,
            "timezone": "Australia/Sydney",
            "airline": airline,
            "window_local": {"start": start_local, "end": end_local},
            "count": len(matched),
            "flights": matched,
        }
    )


@app.post("/api/flights/pull")
def api_flights_pull():
    """EWOT: Explicit, user-driven ingest trigger for a given airport/date.

    Brain stays read-only by default. This endpoint is the explicit "pull now"
    button that forwards to CC3 ingestion and (optionally) stores into DB.
    """

    data = request.get_json(silent=True)
    if data is None:
        if request.data:
            return json_error(
                "Invalid JSON body.",
                status_code=400,
                code="invalid_json",
            )
        data = {}

    if not isinstance(data, dict):
        return json_error(
            "Request body must be a JSON object.",
            status_code=400,
            code="bad_request",
        )

    airport, airport_err = _require_airport_field(data)
    if airport_err is not None:
        return airport_err

    date_str = str(data.get("date") or "").strip()
    if not date_str:
        return json_error(
            "date is required",
            status_code=400,
            code="validation_error",
        )
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return json_error(
            "date must be in YYYY-MM-DD format",
            status_code=400,
            code="validation_error",
        )

    airline, airline_err = _normalize_airline_param(
        data.get("airline"),
        data.get("operator"),
    )
    if airline_err is not None:
        return airline_err
    raw_timeout = data.get("timeout", 30)
    try:
        timeout = int(raw_timeout)
    except (TypeError, ValueError):
        return json_error(
            "timeout must be an integer >= 10",
            status_code=400,
            code="validation_error",
        )
    timeout = max(timeout, 10)

    # Map Brain operator -> CC3 airlines filter.
    # - ALL => no airline filter
    # - otherwise => airlines=[operator]
    airlines = None
    if airline != "ALL":
        airlines = [airline]

    upstream_path = "/api/flights/ingest/aeroapi"
    upstream_body: Dict[str, Any] = {
        "airport": airport,
        "date": date_str,
        "scope": str(data.get("scope") or "both"),
        "store": bool(data.get("store", True)),
        "timeout": timeout,
    }
    if airlines:
        upstream_body["airlines"] = airlines

    try:
        resp = requests.post(
            _upstream_url(upstream_path),
            json=upstream_body,
            timeout=max(timeout, 10),
        )
    except requests.RequestException as exc:
        app.logger.exception("Failed to call upstream flights ingest")
        return json_error(
            "Upstream flights ingest endpoint unavailable",
            status_code=502,
            code="upstream_error",
            detail={"detail": str(exc), "upstream_path": upstream_path},
        )

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return json_error(
            "Invalid JSON from upstream flights ingest endpoint.",
            status_code=502,
            code="invalid_json",
            detail={"raw": resp.text[:500], "upstream_path": upstream_path},
        )

    # Normalize response so UI/PS can depend on stable keys.
    out: Dict[str, Any] = {
        "ok": bool(payload.get("ok")) if isinstance(payload, dict) else False,
        "airport": airport,
        "local_date": date_str,
        "airline": airline,
        "source": "upstream",
        "upstream": {
            "base_url": _active_upstream_base(),
            "path": upstream_path,
            "status_code": resp.status_code,
        },
        "payload": payload,
    }

    return jsonify(out), resp.status_code


@app.post("/api/ops/complete_day")
def api_ops_complete_day():
    """Trigger CC3 SYD airport ingest for a full ops day (store=true)."""

    data = request.get_json(silent=True)
    if data is None:
        if request.data:
            return json_error(
                "Invalid JSON body.",
                status_code=400,
                code="invalid_json",
            )
        data = {}

    if not isinstance(data, dict):
        return json_error(
            "Request body must be a JSON object.",
            status_code=400,
            code="bad_request",
        )

    airport, airport_err = _require_airport_field(data)
    if airport_err is not None:
        return airport_err

    date_str = str(data.get("date") or "").strip()
    if not date_str:
        return json_error(
            "date is required",
            status_code=400,
            code="validation_error",
        )
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        return json_error(
            "date must be in YYYY-MM-DD format",
            status_code=400,
            code="validation_error",
        )

    airlines_value = data.get("airlines")
    if airlines_value is None or str(airlines_value).strip() == "":
        airlines_value = data.get("airline") or data.get("operator") or "ALL"

    airlines_selected: List[str]
    if isinstance(airlines_value, list):
        airlines_selected = [
            str(item).strip().upper()
            for item in airlines_value
            if str(item).strip()
        ]
    else:
        airlines_text = str(airlines_value or "").strip().upper()
        if not airlines_text or airlines_text == "ALL":
            airlines_selected = []
        else:
            airlines_selected = _parse_airlines_csv(airlines_text)

    raw_timeout = data.get("timeout_seconds", 6)
    try:
        request_timeout = int(raw_timeout)
    except (TypeError, ValueError):
        return json_error(
            "timeout_seconds must be an integer >= 1",
            status_code=400,
            code="validation_error",
        )
    if request_timeout < 1:
        return json_error(
            "timeout_seconds must be an integer >= 1",
            status_code=400,
            code="validation_error",
        )

    cc3_payload: Dict[str, Any] = {
        "airport": airport,
        "date": date_str,
        "scope": "both",
        "store": True,
        "airlines": airlines_selected,
        "timeout": 15,
    }
    cc3_url = f"{_cc3_ingest_base()}/api/flights/ingest/sydairport"

    try:
        resp = requests.post(cc3_url, json=cc3_payload, timeout=request_timeout)
    except requests.RequestException as exc:
        return jsonify(
            {
                "ok": False,
                "airport": airport,
                "local_date": date_str,
                "airlines_selected": airlines_selected,
                "cc3": {
                    "ok": False,
                    "status_code": None,
                    "error": str(exc),
                    "stored_rows": None,
                    "count": None,
                    "source": None,
                    "warnings": [],
                },
            }
        ), 200

    status_code = resp.status_code
    payload: Optional[Dict[str, Any]]
    try:
        raw_payload = resp.json()
        payload = raw_payload if isinstance(raw_payload, dict) else None
    except Exception:  # noqa: BLE001
        payload = None

    def _extract_cc3_error(body: Optional[Dict[str, Any]]) -> Optional[str]:
        if not body:
            return None
        err = body.get("error")
        if isinstance(err, dict):
            message = err.get("message") or err.get("detail")
            if message:
                return str(message)
            return json.dumps(err)
        if err:
            return str(err)
        message = body.get("message") or body.get("detail")
        if message:
            return str(message)
        return None

    cc3_ok = bool(payload.get("ok")) if payload else resp.ok
    cc3_error = _extract_cc3_error(payload)
    if not cc3_ok and not cc3_error:
        cc3_error = resp.text[:500] if resp.text else "CC3 ingest failed."

    cc3_block = {
        "ok": cc3_ok,
        "status_code": status_code,
        "error": None if cc3_ok else cc3_error,
        "stored_rows": payload.get("stored_rows") if payload else None,
        "count": payload.get("count") if payload else None,
        "source": payload.get("source") if payload else None,
        "warnings": payload.get("warnings") if payload and isinstance(payload.get("warnings"), list) else [],
    }

    return jsonify(
        {
            "ok": cc3_ok,
            "airport": airport,
            "local_date": date_str,
            "airlines_selected": airlines_selected,
            "cc3": cc3_block,
        }
    ), 200


@app.get("/api/employee_assignments/daily")
def api_employee_assignments_daily():
    """
    EWOT: Optional staff overlay endpoint.
    It must NEVER block the UI. Even if upstream is missing/404/HTML/timeout, return HTTP 200:
      { ok:true, available:false, reason:..., assignments:{} }
    """
    date_str = (request.args.get("date") or "").strip()
    airport = (request.args.get("airport") or "").strip().upper()
    operator = (request.args.get("operator") or "ALL").strip().upper()
    shift = (request.args.get("shift") or "ALL").strip().upper()

    # enforce contract (airport required, date required)
    if not date_str:
        return jsonify({"ok": False, "error": {"code": "validation_error", "message": "Missing required 'date' query parameter."}}), 400
    if not airport:
        return jsonify({"ok": False, "error": {"code": "validation_error", "message": "Missing required 'airport' query parameter."}}), 400

    shift_requested = _normalize_shift_param(shift)
    staff = _staff_for_shift(_load_staff_seed(), shift_requested)
    flights = _fetch_flights_for_assignment(
        date_str=date_str,
        airport=airport,
        airline=operator,
    )
    assignments = _build_assignments_for_flights(flights, staff)

    payload = {
        "ok": True,
        "available": True,
        "airport": airport,
        "local_date": date_str,
        "operator": operator,
        "shift": shift_requested,
        "assignments": assignments,
    }

    return jsonify(payload), 200
@app.get("/api/staff")
def api_staff():
    """Proxy staff directory overlay to CC3 (non-blocking)."""

    if (date_error := _require_date_param()) is not None:
        return date_error

    airport = (request.args.get("airport") or "").strip().upper()
    if not airport:
        return json_error(
            "Missing required 'airport' query parameter.",
            status_code=400,
            code="validation_error",
        )

    # Canonical multi-select (Brain-owned)
    airlines_csv = (request.args.get("airlines") or "").strip().upper()
    airlines_list = _parse_airlines_csv(airlines_csv) if (airlines_csv and airlines_csv != "ALL") else []

    airline, airline_err = _normalize_airline_param(
        request.args.get("airline"),
        request.args.get("operator"),
    )
    if airline_err is not None:
        return airline_err

    params = request.args.to_dict(flat=True)
    params.pop("operator", None)
    if airline:
        params["airline"] = airline
    fallback = {
        "ok": True,
        "available": False,
        "reason": "upstream_unavailable",
        "count": 0,
        "staff": [],
    }

    try:
        resp = requests.get(_upstream_url("/api/staff"), params=params, timeout=8)
    except requests.RequestException:
        return jsonify(fallback), 200

    if resp.status_code != 200:
        return jsonify(fallback), 200

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return jsonify(fallback), 200

    return jsonify(payload), 200


@app.get("/api/assignments")
def api_assignments_daily():
    """Proxy daily staff assignments overlay to CC3 (non-blocking)."""

    if (date_error := _require_date_param()) is not None:
        return date_error

    airport = (request.args.get("airport") or "").strip().upper()
    if not airport:
        return json_error(
            "Missing required 'airport' query parameter.",
            status_code=400,
            code="validation_error",
        )

    # Canonical multi-select (Brain-owned)
    airlines_csv = (request.args.get("airlines") or "").strip().upper()
    airlines_list = _parse_airlines_csv(airlines_csv) if (airlines_csv and airlines_csv != "ALL") else []

    airline, airline_err = _normalize_airline_param(
        request.args.get("airline"),
        request.args.get("operator"),
    )
    if airline_err is not None:
        return airline_err

    params = request.args.to_dict(flat=True)
    params.pop("operator", None)
    if airline:
        params["airline"] = airline
    fallback = {
        "ok": True,
        "available": False,
        "reason": "upstream_unavailable",
        "count": 0,
        "assignments": [],
    }

    try:
        resp = requests.get(_upstream_url("/api/assignments"), params=params, timeout=8)
    except requests.RequestException:
        return jsonify(fallback), 200

    if resp.status_code != 200:
        return jsonify(fallback), 200

    try:
        payload = resp.json()
    except Exception:  # noqa: BLE001
        return jsonify(fallback), 200

    return jsonify(payload), 200


def _parse_airlines_csv(value: str) -> List[str]:
    """
    EWOT: Parse a CSV like 'JQ,QF' into ['JQ','QF'] (uppercased, deduped, order preserved).
    """
    raw = (value or "").strip()
    if not raw:
        return []
    parts = []
    for t in raw.split(","):
        c = t.strip().upper()
        if c:
            parts.append(c)
    seen = set()
    out = []
    for c in parts:
        if c not in seen:
            out.append(c)
            seen.add(c)
    return out


# ---------------------------------------------------------------------------
# Runs daily + auto-assign (core of the Runs page)
# ---------------------------------------------------------------------------
@app.get("/api/runs")
def api_runs_cc3():
    """
    EWOT: Proxy CC3-style runs endpoint (GET /api/runs?date&airport&airline&shift)
    so Brain can talk to CC3 without the frontend doing direct cross-origin calls.
    """
    guard = _reject_unknown_query_params("api_runs", ALLOWED_QUERY_PARAMS["api_runs"])
    if guard is not None:
        return guard

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

    airlines_csv = request.args.get("airlines") or ""
    airlines_requested = bool(airlines_csv.strip())
    airlines_list = _parse_airlines_csv(airlines_csv) if airlines_requested else []
    if airlines_csv.strip().upper() == "ALL":
        airlines_list = []
    if airlines_requested:
        airline = "ALL"
    else:
        airline, airline_err = _normalize_airline_param(
            request.args.get("airline"),
            request.args.get("operator"),
        )
        if airline_err is not None:
            return airline_err
    shift = request.args.get("shift", "ALL")
    params = {"date": date_str, "airport": airport, "shift": shift, "airline": airline}

    active_base = _active_upstream_base().rstrip("/")

    # Prefer CC3 canonical runs endpoint
    runs_paths = ["/api/runs"]

    resp = None
    last_error = None
    for path in runs_paths:
        url = f"{active_base}{path}"
        try:
            candidate = requests.get(
                url,
                params=params,
                timeout=30,
            )
            if candidate.status_code == 404:
                continue
            candidate.raise_for_status()
            resp = candidate
            break
        except requests.RequestException as exc:
            last_error = str(exc)
            continue

    try:
        payload = resp.json() if resp is not None else {}
    except Exception:  # noqa: BLE001
        payload = {}

    # ---- Normalize to Brain envelope ----
    runs = payload.get("runs") or []
    needs_placeholder = not runs
    if payload.get("count") in (0, "0"):
        needs_placeholder = True

    if resp is None or needs_placeholder:
        staff = _staff_for_shift(_load_staff_seed(), _normalize_shift_param(shift))
        flights_paths = [
            "/api/ops/schedule/flights",
            "/api/ops/flights",
            "/api/flights",
        ]
        flights_params = {"date": date_str, "airport": airport, "airline": airline}
        flights = []
        try:
            flights_resp, _ = _call_upstream(flights_paths, params=flights_params, timeout=20)
        except requests.RequestException:
            flights_resp = None

        if flights_resp is not None and flights_resp.status_code != 404:
            try:
                flights_payload = flights_resp.json()
            except Exception:  # noqa: BLE001
                flights_payload = {}

            raw_flights = _extract_flights_list(flights_payload)
            ui_flights = [_normalize_flight_for_ui(f) for f in raw_flights]

            if airlines_list:
                ui_flights = [f for f in ui_flights if (f.get("airline_code") in airlines_list)]
            elif airline and airline != "ALL":
                ui_flights = [f for f in ui_flights if (f.get("airline_code") == airline)]

            flights = ui_flights
        assignments = _build_assignments_for_flights(flights, staff)
        runs = _build_runs_from_assignments(
            assignments,
            staff,
            shift_requested=_normalize_shift_param(shift),
        )
        payload = {
            "ok": True,
            "source": "placeholder",
            "runs": runs,
            "count": len(runs),
        }

        # If airlines=CSV is used, filter flights INSIDE each run, then drop empty runs
    if airlines_list:
        filtered_runs = []
        for run in runs:
            if not isinstance(run, dict):
                continue

            # Filter list-of-flights shape
            if isinstance(run.get("flights"), list):
                run["flights"] = [
                    f for f in run["flights"]
                    if isinstance(f, dict) and _flight_airline_code(f) in airlines_list
                ]

            # Filter single-flight shape (compat)
            if isinstance(run.get("flight"), dict):
                if _flight_airline_code(run["flight"]) not in airlines_list:
                    run["flight"] = None

            has_flights_list = isinstance(run.get("flights"), list) and len(run["flights"]) > 0
            has_single_flight = isinstance(run.get("flight"), dict)

            if has_flights_list or has_single_flight:
                filtered_runs.append(run)

        runs = filtered_runs


    count = len(runs) if airlines_list else int(payload.get("count") or len(runs))

    out = {
        "ok": bool(payload.get("ok", True)),
        "source": payload.get("source") or ("upstream" if resp is not None else "placeholder"),
        "airport": payload.get("airport") or airport,
        "local_date": payload.get("local_date") or payload.get("date") or date_str,
        "airline": airline,
        "airlines_selected": airlines_list if airlines_list else [airline],
        "count": count,
        "shift_requested": _normalize_shift_param(shift),
        "runs": runs,
    }

    # Preserve unassigned flights if present (compat fields)
    if "unassigned_flights" in payload:
        out["unassigned_flights"] = payload.get("unassigned_flights") or []

    status_code = resp.status_code if resp is not None else 200
    return jsonify(out), status_code
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
    Deprecated: /api/runs/daily endpoint removed in favor of /api/runs.
    """
    app.logger.warning("Deprecated endpoint hit: /api/runs/daily. Returning 410.")
    return json_error(
        "Use /api/runs with airport parameter",
        status_code=410,
        code="deprecated",
    )



@app.post("/api/runs/auto_assign")
def api_runs_auto_assign():
    """
    EWOT: proxy POST /api/runs/auto_assign so the Runs page Auto-assign
    button forwards to CC2 and returns its result.
    """
    data = request.get_json(silent=True) or {}
    date_str = data.get("date")
    airline, airline_err = _normalize_airline_param(
        data.get("airline"),
        data.get("operator"),
    )
    if airline_err is not None:
        return airline_err

    if not date_str:
        return json_error(
            "Missing 'date' field in JSON body.",
            status_code=400,
            code="validation_error",
            detail={"body": data},
        )

    upstream_body = {"date": date_str, "airline": airline}

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
# Root page (redirect to UI entrypoint)
# ---------------------------------------------------------------------------


@app.route("/", methods=["GET", "HEAD"])
def home():
    """Redirect root to the UI dashboard entrypoint."""
    return redirect(url_for("ui_home"))


# ---------------------------------------------------------------------------
# UI entrypoint (dashboard)
# ---------------------------------------------------------------------------


@app.get("/ui")
def ui_home():
    """Dashboard UI entrypoint (served by Brain; calls /api/* which proxy to CC3)."""
    return render_template("home.html")


# ---------------------------------------------------------------------------
# Minimal auth stubs to satisfy layout navigation links
# ---------------------------------------------------------------------------


@app.route("/login", methods=["GET", "POST"], endpoint="login")
def login():
    """Stub login endpoint; sets a session flag then returns to the UI."""

    session["is_authed"] = True
    session.setdefault("display_name", "Supervisor")
    next_url = request.args.get("next") or url_for("ui_home")
    return redirect(next_url)


@app.get("/logout", endpoint="logout")
def logout():
    """Stub logout endpoint; clears the session then returns to the UI."""

    session.clear()
    return redirect(url_for("ui_home"))


# ---------------------------------------------------------------------------
# UI stubs required by templates/_layout.html navigation
# ---------------------------------------------------------------------------


@app.get("/build", endpoint="build")
def build_page():
    return redirect(url_for("ui_home"))


@app.get("/fix", endpoint="fix")
def fix_page():
    return redirect(url_for("ui_home"))


@app.get("/schedule", endpoint="schedule_page")
def schedule_page():
    """Stub route to satisfy home.html Schedule card."""

    return redirect(url_for("planner_page"))


@app.get("/know", endpoint="know")
def know_page():
    return redirect(url_for("ui_home"))


@app.get("/roster", endpoint="roster_page")
def roster_page():
    return redirect(url_for("ui_home"))


@app.get("/planner", endpoint="planner_page")
def planner_page():
    return redirect(url_for("ui_home"))


@app.get("/maintenance", endpoint="maintenance_page")
def maintenance_page():
    return redirect(url_for("ui_home"))


@app.get("/machine-room", endpoint="machine_room")
def machine_room():
    """Stub Machine Room route to satisfy navigation links."""

    return redirect(url_for("ui_home"))

# Even if role-gated in template, define it so templates never explode.
@app.get("/admin/import", endpoint="admin_import_index")
def admin_import_index():
    return redirect(url_for("ui_home"))


if __name__ == "__main__":  # pragma: no cover
    # Local dev convenience; in production Render will run via gunicorn.
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5055")), debug=True)
