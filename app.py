import os
import json
import datetime as dt
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo
from functools import wraps
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

from typing import Iterable

import click
from sqlalchemy import inspect

import requests

from flask import (
    Flask,
    abort,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    session,
    url_for,
    has_request_context,
)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash

from dotenv import load_dotenv

load_dotenv()  # loads OPENAI_API_KEY, FLASK_SECRET_KEY, etc.

from config import CODE_CRAFTER2_API_BASE
from scripts.schema_utils import (
    ensure_employee_schema,
    ensure_flights_schema,
    ensure_run_schema,
)
from services.orchestrator import BuildOrchestrator
from services.fixer import FixService
from services.knowledge import KnowledgeService
from services.importer import ImportService
from services.runs_engine import generate_runs_for_date_airline, get_runs_for_date_airline
from flight_matcher import filter_flights_by_prefix, match_flights_by_rego
from scraper import get_flight_details
app = Flask(__name__)

raw_uri = os.getenv("DATABASE_URL", "sqlite:///cc_office.db")

# Normalize old-style postgres scheme for SQLAlchemy
if raw_uri.startswith("postgres://"):
    raw_uri = raw_uri.replace("postgres://", "postgresql://", 1)

app.config["SECRET_KEY"] = os.getenv("SECRET_KEY", "dev")
app.config["SQLALCHEMY_DATABASE_URI"] = raw_uri
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["ADMIN_KEY"] = os.getenv("ADMIN_KEY")
app.config["SUPERVISOR_KEY"] = os.getenv("SUPERVISOR_KEY")
app.config["CODE_CRAFTER2_API_BASE"] = CODE_CRAFTER2_API_BASE

SUPPORTED_AIRLINES = {"JQ", "QF", "VA", "ZL"}
DEFAULT_AIRLINE = "JQ"
ALLOWED_DAY_OFFSETS = {0, 1, 2}
CODECRAFTER_BASE = os.environ.get("CODECRAFTER_BASE", "https://codecrafter2.onrender.com")

# Preserve a predictable airline order for observability endpoints
SUPPORTED_AIRLINES_ORDERED = ["JQ", "QF", "VA", "ZL"]

SUPPORTED_ROLES = ("admin", "supervisor", "refueler", "viewer")
ROLE_CHOICES = ("admin", "supervisor", "refueler", "viewer")

BASE_DIR = Path(__file__).parent
FRONTEND_BUILD_DIR = BASE_DIR / "frontend_dist"

# --- Sydney-local date helper for ops logic ---
SYD_TZ = ZoneInfo("Australia/Sydney")


def syd_today():
    """Return today's date in Australia/Sydney local time.

    Used by JQ import and any other 'ops day' logic so that imports
    line up with what the Machine Room date picker shows for SYD.
    """
    from datetime import datetime as _dt

    return _dt.now(SYD_TZ).date()


def syd_now():
    """Return the current Australia/Sydney datetime."""

    return datetime.now(SYD_TZ)


def json_error(message: str, *, status_code: int = 500, error_type: str = "internal_error", context: dict | None = None):
    payload = {"ok": False, "error": message, "type": error_type}
    if context:
        payload["context"] = context
    return jsonify(payload), status_code


@app.errorhandler(Exception)
def handle_api_errors(err):
    """Ensure all /api/* routes return JSON, even on unexpected errors."""

    if not request.path.startswith("/api/"):
        raise err

    if isinstance(err, HTTPException):
        error_type = "validation_error" if (err.code or 500) < 500 else "internal_error"
        return json_error(
            err.description or err.name or "Request failed",
            status_code=err.code or 500,
            error_type=error_type,
        )

    app.logger.exception("Unhandled API error")
    return json_error("Internal server error", status_code=500, error_type="internal_error")


TRUCKS = [
    {
        "id": "Truck-1",
        "next_maintenance": "2024-12-01",
        "status": "OK",
        "description": "Initial service seed",
    },
    {
        "id": "Truck-2",
        "next_maintenance": "2024-12-05",
        "status": "Due",
        "description": "Brake inspection",
    },
]


db = SQLAlchemy(app)


def ensure_flight_schema():
    """Ensure the flights table matches the daa586a contract.

    Delegates to :func:`scripts.schema_utils.ensure_flights_schema` for
    idempotent, dialiect-aware migrations.

    Returns a list of actions performed.
    """

    try:
        return ensure_flights_schema(db.engine)
    except Exception as exc:  # noqa: BLE001
        print(f"[schema] Failed to ensure flight schema: {exc}")
        raise


def ensure_runs_schema():
    """Ensure the runs tables exist with the latest columns."""

    try:
        return ensure_run_schema(db.engine)
    except Exception as exc:  # noqa: BLE001
        print(f"[schema] Failed to ensure run schema: {exc}")
        raise


def ensure_employee_table():
    """Ensure the employees table includes the latest columns/indexes."""

    try:
        return ensure_employee_schema(db.engine)
    except Exception as exc:  # noqa: BLE001
        print(f"[schema] Failed to ensure employee schema: {exc}")
        raise


def ensure_staff_run_schema():
    """Ensure the staff run tables exist."""

    try:
        with db.engine.begin() as conn:
            db.metadata.create_all(
                bind=conn, tables=[StaffRun.__table__, StaffRunJob.__table__]
            )
    except Exception as exc:  # noqa: BLE001
        print(f"[schema] Failed to ensure staff run schema: {exc}")
        raise


@app.cli.command("import-employees")
@click.argument("csv_path")
def import_employees_command(csv_path: str):
    """Import employees from a CSV file."""

    from scripts.import_employees_from_csv import import_employees_from_csv

    summary = import_employees_from_csv(csv_path)
    click.echo(
        f"Import complete: processed={summary['processed']}, "
        f"created={summary['created']}, updated={summary['updated']}, "
        f"skipped={summary['skipped']}"
    )


def ensure_roster_schema():
    """Ensure roster-related tables (weekly templates) exist."""

    inspector = inspect(db.engine)
    existing_tables = set(inspector.get_table_names())
    actions: list[str] = []

    roster_tables = (
        "staff",
        "roster_template_weeks",
        "roster_template_days",
        "weekly_roster_templates",
    )

    to_create = [
        db.metadata.tables[name]
        for name in roster_tables
        if name in db.metadata.tables and name not in existing_tables
    ]

    if to_create:
        with db.engine.begin() as conn:
            db.metadata.create_all(bind=conn, tables=to_create)
        for table in to_create:
            actions.append(f"created:{table.name}")

    return actions


_PROJECT_SUMMARY_CACHE = None
_PROJECT_SUMMARY_PATH = Path(__file__).parent / "TheBrain" / "project_summary.json"


class FlightFetchError(RuntimeError):
    """Raised when flight data cannot be retrieved from the upstream source."""


def load_project_summary():
    """
    Load and cache the project_summary.json file for Machine Room.

    One sentence explanation: reads TheBrain/project_summary.json once and returns its parsed dict, or {} on error.
    """
    global _PROJECT_SUMMARY_CACHE

    if _PROJECT_SUMMARY_CACHE is not None:
        return _PROJECT_SUMMARY_CACHE

    try:
        if _PROJECT_SUMMARY_PATH.exists():
            with _PROJECT_SUMMARY_PATH.open("r", encoding="utf-8") as f:
                _PROJECT_SUMMARY_CACHE = json.load(f)
        else:
            _PROJECT_SUMMARY_CACHE = {}
    except Exception as exc:  # noqa: BLE001
        # Log and fall back to empty summary; never break Machine Room.
        print(f"[MachineRoom] Failed to load project_summary.json: {exc}")
        _PROJECT_SUMMARY_CACHE = {}

    return _PROJECT_SUMMARY_CACHE


def clamp_day_offset(raw_offset: str | int | None) -> int:
    """Parse and clamp the dayOffset query parameter into the allowed range."""

    try:
        value = int(raw_offset)
    except (TypeError, ValueError):
        return 0

    if value in ALLOWED_DAY_OFFSETS:
        return value

    return 0 if value < 0 else 2


def resolve_airline(raw_airline: str | None) -> str:
    """Return an uppercase airline code, defaulting to the supported one."""

    if not raw_airline:
        return DEFAULT_AIRLINE

    code = raw_airline.strip().upper()
    return code if code in SUPPORTED_AIRLINES else DEFAULT_AIRLINE


def parse_airline_filter(raw_airline: str | None, *, allow_all: bool = True) -> tuple[str | None, str | None]:
    """Parse an optional airline filter from the query string.

    Returns a tuple of (airline_code_or_None, error_message_or_None).
    Passing ``allow_all`` lets callers treat the ``all`` keyword as "no filter".
    """

    if raw_airline is None or raw_airline.strip() == "":
        return None, None

    code = raw_airline.strip().upper()
    if allow_all and code == "ALL":
        return None, None

    if code in SUPPORTED_AIRLINES:
        return code, None

    supported = ", ".join(sorted(SUPPORTED_AIRLINES))
    return None, f"Unsupported airline '{code}'. Supported airlines: {supported}."


def build_source_urls(airline: str, target_date: date) -> list[str]:
    """Construct upstream URLs for the selected airline and date.

    By default this uses the Sydney Airport domestic departures
    direct-view endpoint for *today*. Airline/date filtering is done
    in Python, not via query params.

    You can override the URL via the FLIGHT_SOURCE_URL_TEMPLATE
    environment variable. If you do, you may include the placeholders
    {airline} and {date} (YYYY-MM-DD) if your upstream supports them.
    """

    template = os.getenv(
        "FLIGHT_SOURCE_URL_TEMPLATE",
        (
            "https://www.sydneyairport.com.au/infosyd/direct-view/"
            "44268d53-5830-49f7-bc2a-f64fe9c8cff8/today"
        ),
    )

    # This will happily work even if the default template doesn't
    # use {airline} or {date} – extra kwargs are ignored.
    url = template.format(airline=airline, date=target_date.isoformat())
    return [url]



def fetch_flights(urls: Iterable[str], airline: str) -> list[dict]:
    """Fetch and combine flights from the given URLs, filtering by airline."""

    collected: list[dict] = []
    for url in urls:
        try:
            flights = get_flight_details(url, airline_prefixes=[airline])
            collected.extend(flights)
        except requests.RequestException as exc:  # noqa: PERF203
            raise FlightFetchError(f"Failed to fetch flights from {url}: {exc}") from exc

    filtered = filter_flights_by_prefix(collected, airline)
    return match_flights_by_rego(filtered)


def serve_frontend_spa():
    """
    Serve the built React SPA (Planner/Machine Room).

    Assumes `yarn build` has created `frontend_dist/index.html`.
    If not present, return a helpful 404 message.
    """

    index_path = Path(FRONTEND_BUILD_DIR) / "index.html"
    if not index_path.exists():
        return (
            "React frontend build not found. Run `yarn build` to generate frontend_dist.",
            404,
        )

    return send_from_directory(str(FRONTEND_BUILD_DIR), "index.html")


@app.route("/assets/<path:filename>")
def frontend_assets(filename):
    """Serve static assets from the built React frontend."""

    assets_dir = FRONTEND_BUILD_DIR / "assets"
    if not assets_dir.exists():
        abort(404)

    return send_from_directory(str(assets_dir), filename)


class Employee(db.Model):
    __tablename__ = "employees"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(40), unique=True, nullable=False)
    name = db.Column(db.String(120), nullable=True)
    role = db.Column(db.String(80), nullable=True)
    shift = db.Column(db.String(40), nullable=True)
    base = db.Column(db.String(40), nullable=True)
    employment_type = db.Column(db.String(16), nullable=True)
    weekly_hours_target = db.Column(db.Integer, nullable=True)
    notes = db.Column(db.Text, nullable=True)
    is_active = db.Column("active", db.Boolean, default=True, nullable=False)
    active = db.synonym("is_active")
    created_at = db.Column(
        db.DateTime(timezone=True), server_default=db.func.now(), nullable=False
    )
    updated_at = db.Column(
        db.DateTime(timezone=True),
        server_default=db.func.now(),
        onupdate=db.func.now(),
        nullable=False,
    )


class Flight(db.Model):
    __tablename__ = "flights"

    id = db.Column(db.Integer, primary_key=True)
    flight_number = db.Column(db.String(32), nullable=False)
    airline = db.Column(db.String(4), nullable=True)
    date = db.Column(db.Date, nullable=False)
    imported_at = db.Column(db.DateTime(timezone=True), nullable=True)
    time_local = db.Column(db.Time, nullable=True)
    origin = db.Column(db.String(32), nullable=True)
    destination = db.Column(db.String(32), nullable=True)
    eta_local = db.Column(db.DateTime(timezone=True), nullable=True)
    etd_local = db.Column(db.DateTime(timezone=True), nullable=True)
    operator_code = db.Column(db.String(16), nullable=True)
    aircraft_type = db.Column(db.String(32), nullable=True)
    service_profile_code = db.Column(db.String(64), nullable=True)
    bay = db.Column(db.String(32), nullable=True)
    registration = db.Column(db.String(32), nullable=True)
    status_code = db.Column(db.String(32), nullable=True)
    tail_number = db.Column(db.String(32), nullable=True)
    truck_assignment = db.Column(db.String(64), nullable=True)
    assigned_employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"), nullable=True)
    assigned_employee_name = db.Column(db.String(80), nullable=True)
    assigned_truck = db.Column(db.String(64), nullable=True)
    is_international = db.Column(db.Boolean, nullable=True)
    status = db.Column(db.String(32), nullable=True)
    notes = db.Column(db.Text, nullable=True)

    assigned_employee = db.relationship("Employee", foreign_keys=[assigned_employee_id])


class Run(db.Model):
    __tablename__ = "runs"

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    airline = db.Column(db.String(8), nullable=False)
    registration = db.Column(db.String(32), nullable=False)
    operator_code = db.Column(db.String(16), nullable=True)
    label = db.Column(db.String(64), nullable=True)
    start_time = db.Column(db.DateTime(timezone=True), nullable=True)
    end_time = db.Column(db.DateTime(timezone=True), nullable=True)
    truck_id = db.Column(db.String(64), nullable=True)
    shift_id = db.Column(db.Integer, db.ForeignKey("shifts.id"), nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True),
        server_default=db.func.now(),
        onupdate=db.func.now(),
        nullable=False,
    )

    run_flights = db.relationship(
        "RunFlight",
        backref="run",
        cascade="all, delete-orphan",
        order_by="RunFlight.sequence_index",
    )


class RunFlight(db.Model):
    __tablename__ = "run_flights"

    id = db.Column(db.Integer, primary_key=True)
    run_id = db.Column(db.Integer, db.ForeignKey("runs.id"), nullable=False)
    flight_id = db.Column(db.Integer, db.ForeignKey("flights.id"), nullable=False)
    sequence_index = db.Column(db.Integer, nullable=False)
    planned_time = db.Column(db.Time, nullable=True)
    status = db.Column(db.String(32), nullable=False, default="planned")
    position = db.Column(db.Integer, nullable=True)
    created_at = db.Column(db.DateTime(timezone=True), server_default=db.func.now(), nullable=False)
    updated_at = db.Column(
        db.DateTime(timezone=True),
        server_default=db.func.now(),
        onupdate=db.func.now(),
        nullable=False,
    )

    flight = db.relationship("Flight")

    @property
    def sequence(self):
        """Compatibility accessor for legacy templates expecting position."""

        return self.sequence_index if self.sequence_index is not None else self.position

    @sequence.setter
    def sequence(self, value):
        self.sequence_index = value
        self.position = value


class FlightRun(db.Model):
    __tablename__ = "flight_runs"

    id = db.Column(db.Integer, primary_key=True)
    run_id = db.Column(db.Integer, nullable=False)
    flight_id = db.Column(db.Integer, nullable=False)
    bay = db.Column(db.String(16), nullable=True)
    rego = db.Column(db.String(16), nullable=True)
    on_time = db.Column(db.Boolean, nullable=True)
    status = db.Column(db.String(32), nullable=False, default="planned")
    start_figure = db.Column(db.Integer, nullable=True)
    uplift = db.Column(db.Integer, nullable=True)
    sequence_index = db.Column(db.Integer, nullable=True)
    planned_time = db.Column(db.Time, nullable=True)


class ServiceProfile(db.Model):
    __tablename__ = "service_profiles"

    id = db.Column(db.Integer, primary_key=True)
    code = db.Column(db.String(64), unique=True, nullable=False)
    name = db.Column(db.String(128), nullable=True)
    airline = db.Column(db.String(8), nullable=True)
    window_start_mins = db.Column(db.Integer, nullable=True)
    window_end_mins = db.Column(db.Integer, nullable=True)


class Shift(db.Model):
    __tablename__ = "shifts"

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    label = db.Column(db.String(64), nullable=True)
    start_time = db.Column(db.Time, nullable=True)
    end_time = db.Column(db.Time, nullable=True)


class MaintenanceItem(db.Model):
    __tablename__ = "maintenance_items"

    id = db.Column(db.Integer, primary_key=True)
    truck_id = db.Column(db.String(32), nullable=False)
    description = db.Column(db.Text, nullable=True)
    due_date = db.Column(db.Date, nullable=True)
    status = db.Column(db.String(32), nullable=True)


class RosterEntry(db.Model):
    __tablename__ = "roster_entries"

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    employee_name = db.Column(db.String(80), nullable=False)
    role = db.Column(db.String(32), nullable=True)
    shift_start = db.Column(db.Time, nullable=True)
    shift_end = db.Column(db.Time, nullable=True)
    truck = db.Column(db.String(32), nullable=True)
    notes = db.Column(db.Text, nullable=True)


class WeeklyRosterTemplate(db.Model):
    __tablename__ = "weekly_roster_templates"

    id = db.Column(db.Integer, primary_key=True)
    employee_id = db.Column(db.Integer, db.ForeignKey("employees.id"), nullable=False)
    weekday = db.Column(db.Integer, nullable=False)  # 0=Mon .. 6=Sun
    role = db.Column(db.String(32), nullable=False)
    shift_start = db.Column(db.Time, nullable=True)
    shift_end = db.Column(db.Time, nullable=True)
    truck = db.Column(db.String(32), nullable=True)
    notes = db.Column(db.Text, nullable=True)

    employee = db.relationship("Employee")


class Staff(db.Model):
    __tablename__ = "staff"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    code = db.Column(db.String(20), nullable=False)
    employment_type = db.Column(db.String(2), nullable=False)
    weekly_hours_target = db.Column(db.Integer, nullable=True)
    active = db.Column(db.Boolean, nullable=False, default=True)
    skills = db.Column(db.JSON, nullable=True)


class StaffRun(db.Model):
    __tablename__ = "staff_runs"

    id = db.Column(db.Integer, primary_key=True)
    date = db.Column(db.Date, nullable=False)
    airline = db.Column(db.String(8), nullable=False)
    staff_id = db.Column(db.Integer, db.ForeignKey("staff.id"), nullable=False)
    shift_start = db.Column(db.Time, nullable=True)
    shift_end = db.Column(db.Time, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now())
    updated_at = db.Column(
        db.DateTime, nullable=False, server_default=db.func.now(), onupdate=db.func.now()
    )

    staff = db.relationship("Staff")
    jobs = db.relationship(
        "StaffRunJob",
        back_populates="staff_run",
        cascade="all, delete-orphan",
        order_by="StaffRunJob.sequence",
    )


class StaffRunJob(db.Model):
    __tablename__ = "staff_run_jobs"

    id = db.Column(db.Integer, primary_key=True)
    staff_run_id = db.Column(db.Integer, db.ForeignKey("staff_runs.id"), nullable=False)
    flight_id = db.Column(db.Integer, db.ForeignKey("flights.id"), nullable=False)
    sequence = db.Column(db.Integer, nullable=False, default=0)

    staff_run = db.relationship("StaffRun", back_populates="jobs")
    flight = db.relationship("Flight")


class RosterTemplateWeek(db.Model):
    __tablename__ = "roster_template_weeks"

    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(255), nullable=False, unique=True)
    description = db.Column(db.Text, nullable=True)
    is_active = db.Column(db.Boolean, nullable=False, default=False)

    days = db.relationship(
        "RosterTemplateDay", back_populates="template", cascade="all, delete-orphan"
    )


class RosterTemplateDay(db.Model):
    __tablename__ = "roster_template_days"

    id = db.Column(db.Integer, primary_key=True)
    template_id = db.Column(
        db.Integer, db.ForeignKey("roster_template_weeks.id"), nullable=False
    )
    weekday = db.Column(db.Integer, nullable=False)  # 0=Mon .. 6=Sun
    staff_id = db.Column(db.Integer, db.ForeignKey("staff.id"), nullable=False)
    start_local = db.Column(db.Time, nullable=False)
    end_local = db.Column(db.Time, nullable=False)
    role = db.Column(db.String(64), nullable=False)

    template = db.relationship("RosterTemplateWeek", back_populates="days")
    staff = db.relationship("Staff")


from services.roster import get_daily_roster
from services.roster_engine import auto_assign_employees_for_date, generate_roster_for_date_range


class ImportBatch(db.Model):
    __tablename__ = "import_batches"

    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime, nullable=False, server_default=db.func.now())
    created_by = db.Column(db.String(64), nullable=True)
    import_type = db.Column(db.String(32), nullable=False)
    source_filename = db.Column(db.String(255), nullable=True)
    source_mime = db.Column(db.String(64), nullable=True)
    status = db.Column(db.String(32), nullable=False, default="pending")


class ImportRow(db.Model):
    __tablename__ = "import_rows"

    id = db.Column(db.Integer, primary_key=True)
    batch_id = db.Column(db.Integer, db.ForeignKey("import_batches.id"), nullable=False)
    batch = db.relationship("ImportBatch", backref=db.backref("rows", lazy=True))

    data = db.Column(db.JSON, nullable=False)
    is_valid = db.Column(db.Boolean, nullable=False, default=True)
    error = db.Column(db.Text, nullable=True)


class AuditLog(db.Model):
    __tablename__ = "audit_logs"

    id = db.Column(db.Integer, primary_key=True)
    entity_type = db.Column(db.String(40), nullable=False)
    entity_id = db.Column(db.Integer, nullable=True)
    action = db.Column(db.String(20), nullable=False)
    timestamp = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    description = db.Column(db.Text, nullable=True)

    actor_role = db.Column(db.String(40), nullable=True)
    actor_name = db.Column(db.String(80), nullable=True)


class User(db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(40), nullable=False, default="refueler")

    def set_password(self, password: str):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password: str) -> bool:
        return check_password_hash(self.password_hash, password)

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"

    @property
    def is_supervisor(self) -> bool:
        return self.role == "supervisor"


from routes_runs_view import bp_runs_view
from routes.flight_runs import flight_runs_bp

app.register_blueprint(bp_runs_view)
app.register_blueprint(flight_runs_bp)


def get_current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return User.query.get(user_id)


def get_current_role():
    user = get_current_user()
    role = user.role if user else session.get("role")
    if role not in SUPPORTED_ROLES:
        return None
    return role


def require_role(*roles):
    def decorator(view_func):
        @wraps(view_func)
        def wrapper(*args, **kwargs):
            user = get_current_user()
            role = get_current_role()

            if not user and not role:
                flash("Please log in to access this page.", "warning")
                return redirect(url_for("login", next=request.path))

            if role == "admin" or (user and user.is_admin):
                return view_func(*args, **kwargs)

            if roles:
                if role not in roles and not (user and user.role in roles):
                    flash("You do not have permission to access this page.", "danger")
                    return redirect(url_for("home"))

            return view_func(*args, **kwargs)

        return wrapper

    return decorator


def requires_supervisor(f):
    return require_role("supervisor")(f)


def detect_db_type(uri: str) -> str:
    if not uri:
        return "Unknown"
    if uri.startswith("postgres"):
        return "PostgreSQL"
    if uri.startswith("sqlite"):
        return "SQLite"
    return "Unknown"


def log_audit(entity_type, entity_id, action, description=None):
    """
    Record a simple audit event in the AuditLog table.
    """
    user = get_current_user() if has_request_context() else None
    role = None

    if has_request_context():
        role = get_current_role()

    role = role or "viewer"
    entry = AuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        description=description,
        actor_role=role,
        actor_name=user.username if user else None,
    )
    db.session.add(entry)


def _parse_date(val):
    if not val:
        return None
    if isinstance(val, dt.date):
        return val
    s = str(val).strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
        try:
            return dt.datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _parse_time(val):
    if not val:
        return None
    if isinstance(val, dt.time):
        return val
    s = str(val).strip()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return dt.datetime.strptime(s, fmt).time()
        except ValueError:
            continue
    return None


def _combine_date_and_time(date_val: date | None, time_val: time | datetime | None):
    if not date_val or not time_val:
        return None
    if isinstance(time_val, datetime):
        return time_val if time_val.tzinfo else time_val.replace(tzinfo=SYD_TZ)
    if isinstance(time_val, time):
        return datetime.combine(date_val, time_val, tzinfo=SYD_TZ)
    return None


@app.context_processor
def inject_role():
    return {
        "get_current_role": get_current_role,
        "current_user": get_current_user(),
        "current_role": get_current_role(),
        "display_name": session.get("display_name"),
    }

app.config["UPLOAD_FOLDER"] = BASE_DIR / "uploads"
app.config["OUTPUTS_DIR"] = BASE_DIR / "outputs"
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["OUTPUTS_DIR"], exist_ok=True)

orchestrator = BuildOrchestrator(outputs_dir=app.config["OUTPUTS_DIR"])
fixer = FixService()
knower = KnowledgeService(outputs_dir=app.config["OUTPUTS_DIR"])
import_service = ImportService(db=db, ImportBatch=ImportBatch, ImportRow=ImportRow)

# ----- API: Flights -----
@app.get("/api/flight-info")
def flight_info():
    """Return matched flights for the requested airline and day offset."""

    airline = resolve_airline(request.args.get("airline", DEFAULT_AIRLINE))
    day_offset = clamp_day_offset(request.args.get("dayOffset", 0))
    target_date = date.today() + timedelta(days=day_offset)

    source_urls = build_source_urls(airline, target_date)

    try:
        flights = fetch_flights(source_urls, airline)
    except FlightFetchError as exc:
        return jsonify({"error": str(exc)}), 503

    response = {
        "airline": airline,
        "dayOffset": day_offset,
        "date": target_date.isoformat(),
        "count": len(flights),
        "flights": flights,
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
    return jsonify(response)


def run_three_day_import(airline_prefix: str) -> dict:
    """Import three days of flights for the given airline prefix."""

    base_date = syd_today()
    total_imported = 0
    per_day: list[dict] = []

    ensure_flight_schema()

    for offset in range(3):  # 0=today, 1=tomorrow, 2=day after (all SYD local)
        target_date = base_date + timedelta(days=offset)

        source_urls = build_source_urls(airline_prefix, target_date)
        flights = fetch_flights(source_urls, airline_prefix)

        existing_q = Flight.query.filter(
            Flight.date == target_date,
            Flight.flight_number.ilike(f"{airline_prefix}%"),
        )
        existing_count = existing_q.count()
        existing_q.delete(synchronize_session=False)

        imported = 0
        imported_with_time = 0
        for f in flights:
            flight_number = (f.get("flight_number") or "").strip()
            if not flight_number:
                continue

            dest = (f.get("destination") or "").strip() or None
            tail = (f.get("rego") or "").strip() or None
            status = (f.get("status") or "").strip() or None
            scheduled_str = f.get("scheduled_time_str")
            etd_dt = parse_scheduled_time(target_date, scheduled_str, flight_number)

            row = Flight(
                flight_number=flight_number,
                date=target_date,
                imported_at=syd_now(),
                origin="SYD",
                destination=dest,
                eta_local=None,
                etd_local=etd_dt,
                tail_number=tail,
                truck_assignment=None,
                status=status or "scheduled",
                notes=None,
            )
            db.session.add(row)
            imported += 1
            if etd_dt:
                imported_with_time += 1

        db.session.flush()
        per_day.append(
            {
                "date": target_date.isoformat(),
                "found": len(flights),
                "upserted": imported,
                "replaced_existing": int(existing_count),
                "with_times": imported_with_time,
                "ok": True,
            }
        )
        total_imported += imported

        app.logger.info(
            "%s import: %s imported %s flights, %s with etd_local, %s without times",
            airline_prefix,
            target_date.isoformat(),
            imported,
            imported_with_time,
            imported - imported_with_time,
        )

    db.session.commit()

    return {
        "ok": True,
        "airline": airline_prefix,
        "base_date": base_date.isoformat(),
        "total_imported": total_imported,
        "days": per_day,
    }


def _get_import_timestamp_column():
    """Return the most specific timestamp expression available for imports."""

    imported_at = getattr(Flight, "imported_at", None)
    etd_local = getattr(Flight, "etd_local", None)

    if imported_at is not None:
        if etd_local is not None:
            return db.func.coalesce(imported_at, etd_local), "imported_at"
        return imported_at, "imported_at"

    for attr in ("updated_at", "created_at", "etd_local"):
        column = getattr(Flight, attr, None)
        if column is not None:
            return column, attr
    return None, None


def _serialize_timestamp(value):
    """Return an ISO 8601 string for datetimes/dates, otherwise None."""

    if value is None:
        return None

    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None

    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=SYD_TZ)
        return value.isoformat()

    if isinstance(value, date):
        return datetime.combine(value, time(), tzinfo=SYD_TZ).isoformat()

    return None


@app.post("/api/import/live")
def import_live():
    """Import live flights for a requested airline prefix."""

    requested_airline = request.args.get("airline")
    airline, error = parse_airline_filter(requested_airline, allow_all=False)
    if error or not airline:
        message = error or "Query parameter 'airline' is required."
        return jsonify({"ok": False, "error": message}), 400

    try:
        summary = run_three_day_import(airline)
    except FlightFetchError as exc:  # noqa: PERF203
        db.session.rollback()
        app.logger.exception("Flight fetch failed for airline %s", airline)
        return (
            jsonify(
                {
                    "ok": False,
                    "error": str(exc),
                    "airline": airline,
                    "type": "fetch_error",
                }
            ),
            503,
        )
    except Exception:  # noqa: BLE001
        db.session.rollback()
        app.logger.exception("Unexpected error during live import for %s", airline)
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Unexpected error during import.",
                    "airline": airline,
                    "type": "internal_error",
                }
            ),
            500,
        )

    return jsonify({"ok": True, "summary": summary}), 200


@app.post("/api/import/jq_live")
def import_jq_live_local():
    """Legacy wrapper for importing Jetstar flights."""

    try:
        summary = run_three_day_import(DEFAULT_AIRLINE)
    except FlightFetchError as exc:  # noqa: PERF203
        db.session.rollback()
        app.logger.exception("Flight fetch failed for airline %s", DEFAULT_AIRLINE)
        return (
            jsonify(
                {
                    "ok": False,
                    "error": str(exc),
                    "airline": DEFAULT_AIRLINE,
                    "type": "fetch_error",
                }
            ),
            503,
        )
    except Exception:  # noqa: BLE001
        db.session.rollback()
        app.logger.exception(
            "Unexpected error during live import for %s", DEFAULT_AIRLINE
        )
        return (
            jsonify(
                {
                    "ok": False,
                    "error": "Unexpected error during import.",
                    "airline": DEFAULT_AIRLINE,
                    "type": "internal_error",
                }
            ),
            500,
        )

    return jsonify({"ok": True, "summary": summary}), 200


@app.get("/api/ops/import_status")
def import_status():
    """Return supported airlines and last import timestamps."""

    import_route_present = "import_live" in app.view_functions
    timestamp_column, timestamp_source = _get_import_timestamp_column()

    last_import: dict[str, str | None] = {}

    for airline in SUPPORTED_AIRLINES_ORDERED:
        if timestamp_column is None:
            last_import[airline] = None
            continue

        try:
            value = (
                db.session.query(db.func.max(timestamp_column))
                .filter(Flight.flight_number.ilike(f"{airline}%"))
                .scalar()
            )
        except Exception:  # noqa: BLE001
            db.session.rollback()
            app.logger.exception(
                "Failed to fetch last import timestamp for airline %s", airline
            )
            value = None

        last_import[airline] = _serialize_timestamp(value)

    response = {
        "ok": True,
        "endpoints": {"import_live": import_route_present},
        "supported_airlines": SUPPORTED_AIRLINES_ORDERED,
        "last_import": last_import,
    }

    if timestamp_source:
        response["timestamp_source"] = timestamp_source

    return jsonify(response), 200


# ----- Pages -----
@app.route("/")
def home():
    return render_template("home.html", job=None)


@app.route("/login", methods=["GET", "POST"])
def login():
    next_url = request.args.get("next") or url_for("home")

    if request.method == "POST":
        next_url = request.form.get("next") or next_url

        admin_key_input = (request.form.get("admin_key") or "").strip()
        supervisor_key_input = (request.form.get("supervisor_key") or "").strip()
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""

        admin_key = app.config.get("ADMIN_KEY")
        supervisor_key = app.config.get("SUPERVISOR_KEY")

        if admin_key_input and admin_key and admin_key_input == admin_key:
            session.clear()
            session["user_id"] = None
            session["role"] = "admin"
            session["display_name"] = "Admin (key)"
            flash("Admin access granted.", "success")
            return redirect(next_url)

        if supervisor_key_input and supervisor_key and supervisor_key_input == supervisor_key:
            session.clear()
            session["user_id"] = None
            session["role"] = "supervisor"
            session["display_name"] = "Supervisor (key)"
            flash("Supervisor access granted.", "success")
            return redirect(next_url)

        if username and password:
            user = User.query.filter_by(username=username).first()
            if not user or not user.check_password(password):
                flash("Invalid username or password.", "danger")
                return render_template("login.html", next_url=next_url)

            session.clear()
            session["user_id"] = user.id
            session["role"] = user.role
            session["display_name"] = user.username
            flash(f"Logged in as {user.username} ({user.role}).", "success")
            return redirect(next_url)

        flash("Please enter a valid admin key, supervisor key, or username/password.", "danger")
        return render_template("login.html", next_url=next_url)

    return render_template("login.html", next_url=next_url)


@app.route("/logout")
def logout():
    """
    Clear login session.
    """
    session.clear()
    flash("You have been logged out.", "info")
    return redirect(url_for("home"))


@app.route("/admin/users")
@require_role("admin")
def admin_users():
    users = User.query.order_by(User.username.asc()).all()
    return render_template("admin_users.html", users=users)


@app.route("/admin/users/new", methods=["GET", "POST"])
@require_role("admin")
def admin_users_new():
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        role = (request.form.get("role") or "refueler").strip()
        password = request.form.get("password") or ""

        if not username or not password:
            flash("Username and password are required.", "danger")
            return render_template("admin_users_form.html", mode="new")

        if role not in ROLE_CHOICES:
            flash("Invalid role.", "danger")
            return render_template("admin_users_form.html", mode="new")

        existing = User.query.filter_by(username=username).first()
        if existing:
            flash("Username already exists.", "danger")
            return render_template("admin_users_form.html", mode="new")

        user = User(username=username, role=role)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        flash(f"User {username} created with role {role}.", "success")
        return redirect(url_for("admin_users"))

    return render_template("admin_users_form.html", mode="new")


@app.route("/admin/users/<int:user_id>/edit", methods=["GET", "POST"])
@require_role("admin")
def admin_users_edit(user_id):
    user = User.query.get_or_404(user_id)

    if request.method == "POST":
        role = (request.form.get("role") or user.role).strip()
        new_password = request.form.get("password") or ""

        if role not in ROLE_CHOICES:
            flash("Invalid role.", "danger")
            return render_template("admin_users_form.html", mode="edit", user=user)

        user.role = role
        if new_password:
            user.set_password(new_password)

        db.session.commit()
        flash(f"User {user.username} updated.", "success")
        return redirect(url_for("admin_users"))

    return render_template("admin_users_form.html", mode="edit", user=user)

@app.route("/build", methods=["GET", "POST"])
def build():
    return render_template("build.html", job=None, steps=[])

@app.route("/fix", methods=["GET", "POST"])
def fix():
    return render_template("fix.html", fix_report=None)

@app.route("/know", methods=["GET", "POST"])
def know():
    prefill_question = request.args.get("voice_q", "")

    if request.method == "POST":
        question = request.form.get("question", "").strip()
        prefill_question = question

    return render_template("know.html", answer=None, prefill_question=prefill_question)

# ----- Pages: Office Manager -----
@app.route("/roster")
@require_role("refueler", "supervisor", "admin")
def roster_page():
    """
    Roster page showing current employees and their shifts.
    Supports simple date and role filters via query parameters.
    """
    q_date_str = request.args.get("date", "").strip()
    q_role = request.args.get("role", "").strip()

    query = RosterEntry.query

    # Optional date filter
    q_date = _parse_date(q_date_str)
    if q_date:
        query = query.filter(RosterEntry.date == q_date)

    # Optional role filter (partial match)
    if q_role:
        query = query.filter(RosterEntry.role.ilike(f"%{q_role}%"))

    roster_entries = query.order_by(RosterEntry.date.asc(), RosterEntry.shift_start.asc()).all()

    # Distinct dates and roles for filter dropdowns
    date_rows = db.session.query(RosterEntry.date).distinct().all()
    role_rows = db.session.query(RosterEntry.role).distinct().all()
    filter_dates = sorted([r[0] for r in date_rows if r[0] is not None])
    filter_roles = sorted([r[0] for r in role_rows if r[0]])

    return render_template(
        "roster.html",
        roster_entries=roster_entries,
        filter_date=q_date_str,
        filter_role=q_role,
        filter_dates=filter_dates,
        filter_roles=filter_roles,
    )


@app.route("/employees")
@require_role("supervisor", "admin")
def employees_index():
    """
    List all employees (crew members) for supervisors/admins.
    """
    ensure_employee_table()
    employees = Employee.query.order_by(Employee.name.asc(), Employee.code.asc()).all()
    return render_template("employees.html", employees=employees)


@app.route("/employees/new", methods=["GET", "POST"])
@requires_supervisor
def employee_create():
    """
    Create a new employee (crew member).
    GET: render empty form.
    POST: validate fields and insert Employee row.
    """
    ensure_employee_table()
    if request.method == "POST":
        code = request.form.get("code", "").strip().upper()
        name = request.form.get("name", "").strip()
        role = request.form.get("role", "").strip()
        employment_type = request.form.get("employment_type", "").strip()
        weekly_hours_raw = request.form.get("weekly_hours_target", "").strip()
        notes = request.form.get("notes", "").strip()
        shift = request.form.get("shift", "").strip()
        base = request.form.get("base", "").strip()
        is_active = request.form.get("active") == "on"

        weekly_hours_target = None
        if weekly_hours_raw:
            try:
                weekly_hours_target = int(weekly_hours_raw)
            except ValueError:
                flash("Weekly hours target must be a whole number.", "error")
                return render_template("employee_form.html", employee=None)

        if not code:
            flash("Code is required.", "error")
        else:
            emp = Employee(
                code=code,
                name=name,
                role=role,
                employment_type=employment_type or None,
                weekly_hours_target=weekly_hours_target,
                notes=notes or None,
                shift=shift,
                base=base or None,
                is_active=is_active,
            )
            db.session.add(emp)
            db.session.flush()
            log_audit(
                entity_type="Employee",
                entity_id=emp.id,
                action="create",
                description=f"Created employee {emp.name} role={emp.role} shift={emp.shift} base={emp.base}",
            )
            db.session.commit()
            flash("Employee created.", "success")
            return redirect(url_for("roster_page"))

    return render_template("employee_form.html", employee=None)


@app.route("/employees/<int:employee_id>/edit", methods=["GET", "POST"])
@requires_supervisor
def employee_edit(employee_id):
    """
    Edit an existing employee.
    """
    emp = Employee.query.get_or_404(employee_id)

    ensure_employee_table()

    if request.method == "POST":
        code = request.form.get("code", "").strip().upper()
        name = request.form.get("name", "").strip()
        role = request.form.get("role", "").strip()
        employment_type = request.form.get("employment_type", "").strip()
        weekly_hours_raw = request.form.get("weekly_hours_target", "").strip()
        notes = request.form.get("notes", "").strip()
        shift = request.form.get("shift", "").strip()
        base = request.form.get("base", "").strip()
        is_active = request.form.get("active") == "on"

        weekly_hours_target = None
        if weekly_hours_raw:
            try:
                weekly_hours_target = int(weekly_hours_raw)
            except ValueError:
                flash("Weekly hours target must be a whole number.", "error")
                return render_template("employee_form.html", employee=emp)

        if not code:
            flash("Code is required.", "error")
        else:
            before = (
                f"{emp.code} {emp.name} role={emp.role} shift={emp.shift} base={emp.base} "
                f"active={emp.is_active} type={emp.employment_type} hours={emp.weekly_hours_target}"
            )
            emp.code = code
            emp.name = name or None
            emp.role = role or None
            emp.employment_type = employment_type or None
            emp.weekly_hours_target = weekly_hours_target
            emp.notes = notes or None
            emp.shift = shift or None
            emp.base = base or None
            emp.is_active = is_active
            after = (
                f"{emp.code} {emp.name} role={emp.role} shift={emp.shift} base={emp.base} "
                f"active={emp.is_active} type={emp.employment_type} hours={emp.weekly_hours_target}"
            )
            db.session.flush()
            log_audit(
                entity_type="Employee",
                entity_id=emp.id,
                action="update",
                description=f"Employee {employee_id} changed: {before} -> {after}",
            )
            db.session.commit()
            flash("Employee updated.", "success")
            return redirect(url_for("roster_page"))

    return render_template("employee_form.html", employee=emp)


@app.route("/employees/<int:employee_id>/delete", methods=["POST"])
@requires_supervisor
def employee_delete(employee_id):
    """
    Soft delete or hard delete an employee.
    For now: hard delete.
    """
    emp = Employee.query.get_or_404(employee_id)
    summary = f"{emp.name} role={emp.role} shift={emp.shift} base={emp.base} active={emp.active}"
    log_audit(
        entity_type="Employee",
        entity_id=emp.id,
        action="delete",
        description=f"Deleted employee {employee_id}: {summary}",
    )
    db.session.delete(emp)
    db.session.commit()
    flash("Employee deleted.", "success")
    return redirect(url_for("roster_page"))


@app.route("/schedule")
@require_role("refueler", "supervisor", "admin")
def schedule_page():
    """
    Flight schedule page backed by CodeCrafter2's API.
    """
    api_base = app.config.get("CODE_CRAFTER2_API_BASE", "")

    return render_template(
        "schedule.html",
        api_base_url=api_base,
    )


def render_planner_template():
    api_base = app.config.get("CODE_CRAFTER2_API_BASE", "")

    return render_template(
        "planner.html",
        api_base_url=api_base,
    )


@app.route("/planner")
@require_role("refueler", "supervisor", "admin")
def planner_page():
    """Daily Ops Planner SPA entry point."""

    return serve_frontend_spa()


@app.route("/legacy/planner")
@require_role("refueler", "supervisor", "admin")
def legacy_planner_page():
    """Legacy planner template for fallback access."""

    return render_planner_template()


@app.route("/flights/new", methods=["GET", "POST"])
@requires_supervisor
def flight_create():
    """
    Create a new scheduled flight.
    """
    if request.method == "POST":
        flight_number = request.form.get("flight_number", "").strip()
        date_str = request.form.get("date", "").strip()
        origin = request.form.get("origin", "").strip()
        destination = request.form.get("destination", "").strip()
        eta_str = request.form.get("eta_local", "").strip()
        etd_str = request.form.get("etd_local", "").strip()
        tail_number = request.form.get("tail_number", "").strip()
        truck_assignment = request.form.get("truck_assignment", "").strip()
        status = request.form.get("status", "").strip() or None
        notes = request.form.get("notes", "").strip()

        if not flight_number or not date_str:
            flash("Flight number and date are required.", "error")
        else:
            date_val = _parse_date(date_str)
            eta_val = _combine_date_and_time(date_val, _parse_time(eta_str))
            etd_val = parse_scheduled_time(date_val, etd_str, flight_number)

            if not date_val:
                flash("Invalid date format.", "error")
            else:
                f = Flight(
                    flight_number=flight_number,
                    date=date_val,
                    imported_at=syd_now(),
                    origin=origin or None,
                    destination=destination or None,
                    eta_local=eta_val,
                    etd_local=etd_val,
                    tail_number=tail_number or None,
                    truck_assignment=truck_assignment or None,
                    status=status,
                    notes=notes or None,
                )
                db.session.add(f)
                db.session.flush()
                log_audit(
                    entity_type="Flight",
                    entity_id=f.id,
                    action="create",
                    description=(
                        f"Created flight {f.flight_number} date={f.date} "
                        f"eta={f.eta_local} origin={f.origin} destination={f.destination}"
                    ),
                )
                db.session.commit()
                flash("Flight created.", "success")
                return redirect(url_for("schedule_page"))

    return render_template("flight_form.html", flight=None)


@app.route("/flights/<int:flight_id>/edit", methods=["GET", "POST"])
@requires_supervisor
def flight_edit(flight_id):
    """
    Edit an existing flight entry.
    """
    f = Flight.query.get_or_404(flight_id)

    if request.method == "POST":
        flight_number = request.form.get("flight_number", "").strip()
        date_str = request.form.get("date", "").strip()
        origin = request.form.get("origin", "").strip()
        destination = request.form.get("destination", "").strip()
        eta_str = request.form.get("eta_local", "").strip()
        etd_str = request.form.get("etd_local", "").strip()
        tail_number = request.form.get("tail_number", "").strip()
        truck_assignment = request.form.get("truck_assignment", "").strip()
        status = request.form.get("status", "").strip() or None
        notes = request.form.get("notes", "").strip()

        if not flight_number or not date_str:
            flash("Flight number and date are required.", "error")
        else:
            date_val = _parse_date(date_str)
            eta_val = _combine_date_and_time(date_val, _parse_time(eta_str))
            etd_val = parse_scheduled_time(date_val, etd_str, flight_number)

            if not date_val:
                flash("Invalid date format.", "error")
            else:
                before = (
                    f"{f.flight_number} date={f.date} eta={f.eta_local} "
                    f"origin={f.origin} destination={f.destination}"
                )
                f.flight_number = flight_number
                f.date = date_val
                f.origin = origin or None
                f.destination = destination or None
                f.eta_local = eta_val
                f.etd_local = etd_val
                f.tail_number = tail_number or None
                f.truck_assignment = truck_assignment or None
                f.status = status
                f.notes = notes or None
                after = (
                    f"{f.flight_number} date={f.date} eta={f.eta_local} "
                    f"origin={f.origin} destination={f.destination}"
                )
                db.session.flush()
                log_audit(
                    entity_type="Flight",
                    entity_id=f.id,
                    action="update",
                    description=f"Flight {flight_id} changed: {before} -> {after}",
                )
                db.session.commit()
                flash("Flight updated.", "success")
                return redirect(url_for("schedule_page"))

    eta_value = _format_time_for_display(f.eta_local)
    etd_value = _format_time_for_display(f.etd_local)
    return render_template(
        "flight_form.html",
        flight=f,
        eta_value=eta_value,
        etd_value=etd_value,
    )


def delete_flight_record(flight: Flight):
    summary = (
        f"{flight.flight_number} date={flight.date} "
        f"eta={flight.eta_local} origin={flight.origin} destination={flight.destination} status={flight.status}"
    )
    log_audit(
        entity_type="Flight",
        entity_id=flight.id,
        action="delete",
        description=f"Deleted flight {flight.id}: {summary}",
    )
    db.session.delete(flight)
    db.session.commit()
    return summary


@app.route("/flights/<int:flight_id>/confirm-delete", methods=["GET", "POST"])
@require_role("supervisor", "admin")
def flight_confirm_delete(flight_id):
    """
    Confirmation flow for deleting a flight.
    """
    f = Flight.query.get_or_404(flight_id)

    if request.method == "POST":
        delete_flight_record(f)
        flash("Flight deleted.", "success")
        return redirect(url_for("schedule_page"))

    return render_template("flight_confirm_delete.html", flight=f)


@app.route("/flights/<int:flight_id>/delete", methods=["POST"])
@requires_supervisor
def flight_delete(flight_id):
    """
    Delete a flight entry.
    """
    f = Flight.query.get_or_404(flight_id)
    summary = delete_flight_record(f)
    flash("Flight deleted.", "success")
    return redirect(url_for("schedule_page"))


@app.route("/admin/import", methods=["GET"])
@require_role("admin", "supervisor")
def admin_import_index():
    batches = ImportBatch.query.order_by(ImportBatch.created_at.desc()).limit(20).all()
    default_type = request.args.get("import_type", "flights")
    if default_type not in ("flights", "roster", "maintenance"):
        default_type = "flights"
    return render_template("admin_import.html", batches=batches, default_type=default_type)


@app.route("/admin/import/upload", methods=["POST"])
@require_role("admin", "supervisor")
def admin_import_upload():
    import_type = request.form.get("import_type", "flights")
    if import_type not in ("flights", "roster", "maintenance"):
        flash("Invalid import type.", "danger")
        return redirect(url_for("admin_import_index"))

    file = request.files.get("file")
    if not file or not file.filename:
        flash("Please choose a file to upload.", "danger")
        return redirect(url_for("admin_import_index"))

    current_user_name = (session.get("display_name") or session.get("role") or "unknown")

    batch = import_service.create_batch(
        import_type=import_type,
        source_filename=file.filename,
        source_mime=file.mimetype,
        created_by=current_user_name,
    )

    rows = import_service.parse_file_to_rows(import_type, file)

    for row in rows:
        db.session.add(
            ImportRow(
                batch_id=batch.id,
                data=row.data,
                is_valid=(row.error is None),
                error=row.error,
            )
        )
    db.session.commit()

    flash(f"Imported {len(rows)} rows into batch #{batch.id} for review.", "success")
    return redirect(url_for("admin_import_review", batch_id=batch.id))


@app.route("/admin/import/<int:batch_id>/review", methods=["GET", "POST"])
@require_role("admin", "supervisor")
def admin_import_review(batch_id):
    batch = ImportBatch.query.get_or_404(batch_id)

    if request.method == "POST":
        for row in batch.rows:
            prefix = f"row-{row.id}-"
            if request.form.get(prefix + "delete") == "on":
                db.session.delete(row)
                continue

            raw_json = request.form.get(prefix + "data_json") or ""
            try:
                row.data = json.loads(raw_json)
                row.is_valid = True
                row.error = None
            except Exception as e:  # noqa: BLE001
                row.is_valid = False
                row.error = f"Invalid JSON: {e}"
        db.session.commit()
        flash("Rows updated.", "success")
        return redirect(url_for("admin_import_review", batch_id=batch.id))

    return render_template("admin_import_review.html", batch=batch)


@app.route("/admin/import/<int:batch_id>/commit", methods=["POST"])
@require_role("admin")
def admin_import_commit(batch_id):
    batch = ImportBatch.query.get_or_404(batch_id)
    if batch.status != "pending":
        flash("Batch already processed.", "warning")
        return redirect(url_for("admin_import_index"))

    errors = 0
    imported = 0

    for row in batch.rows:
        if not row.is_valid:
            errors += 1
            continue

        data = row.data or {}
        try:
            if batch.import_type == "flights":
                date_val = _parse_date(data.get("date"))
                eta_val = _combine_date_and_time(date_val, _parse_time(data.get("eta_local")))
                etd_val = (
                    parse_scheduled_time(date_val, data.get("etd_local"), data.get("flight_number"))
                    if date_val
                    else None
                )

                f = Flight(
                    flight_number=data.get("flight_number", "").strip(),
                    date=date_val,
                    imported_at=syd_now(),
                    origin=data.get("origin"),
                    destination=data.get("destination"),
                    eta_local=eta_val,
                    etd_local=etd_val,
                    tail_number=data.get("tail_number"),
                    truck_assignment=data.get("truck_assignment"),
                    status=data.get("status"),
                    notes=data.get("notes"),
                )
                db.session.add(f)
            elif batch.import_type == "roster":
                r = RosterEntry(
                    date=_parse_date(data.get("date")),
                    employee_name=data.get("employee_name", "").strip(),
                    role=data.get("role"),
                    shift_start=_parse_time(data.get("shift_start")),
                    shift_end=_parse_time(data.get("shift_end")),
                    truck=data.get("truck"),
                    notes=data.get("notes"),
                )
                db.session.add(r)
            else:
                m = MaintenanceItem(
                    truck_id=data.get("truck_id", "").strip(),
                    description=data.get("description"),
                    due_date=_parse_date(data.get("due_date")),
                    status=data.get("status"),
                )
                db.session.add(m)

            imported += 1
        except Exception as e:  # noqa: BLE001
            row.is_valid = False
            row.error = f"Commit error: {e}"
            errors += 1

    batch.status = "committed"
    db.session.commit()

    flash(f"Committed {imported} rows to {batch.import_type} ({errors} errors).", "success")
    return redirect(url_for("admin_import_index"))


@app.route("/maintenance")
@require_role("refueler", "supervisor", "admin")
def maintenance_page():
    """
    Truck maintenance page showing upcoming service dates.
    One sentence explanation: renders maintenance.html with truck maintenance data from the MaintenanceItem table, falling back to static TRUCKS if empty.
    """
    items = MaintenanceItem.query.order_by(MaintenanceItem.due_date.asc()).all()

    if items:
        # Keep the 'trucks' shape for compatibility with existing template.
        trucks = [
            {
                "id": item.truck_id,
                "next_maintenance": item.due_date.strftime("%Y-%m-%d") if item.due_date else "",
                "status": item.status or "",
                "description": item.description or "",
                "item_id": item.id,
            }
            for item in items
        ]
    else:
        trucks = TRUCKS  # Fallback seed for first run
        items = []

    return render_template("maintenance.html", trucks=trucks, maintenance_items=items)


@app.route("/maintenance/new", methods=["GET", "POST"])
@requires_supervisor
def maintenance_create():
    """
    Create a new maintenance item.
    One sentence explanation: lets supervisors register upcoming maintenance for a truck in the database.
    """
    if request.method == "POST":
        truck_id = request.form.get("truck_id", "").strip()
        due_date_str = request.form.get("due_date", "").strip()
        status = request.form.get("status", "").strip() or None
        description = request.form.get("description", "").strip() or None

        if not truck_id:
            flash("Truck ID is required.", "error")
        else:
            item = MaintenanceItem(
                truck_id=truck_id,
                due_date=_parse_date(due_date_str),
                status=status,
                description=description,
            )
            db.session.add(item)
            db.session.flush()
            log_audit("maintenance", item.id, "create", f"Created maintenance for {truck_id}")
            db.session.commit()
            flash("Maintenance item created.", "success")
            return redirect(url_for("maintenance_page"))

    # GET or validation failure
    return render_template("maintenance_form.html", item=None, mode="new")


@app.route("/maintenance/<int:item_id>/edit", methods=["GET", "POST"])
@requires_supervisor
def maintenance_edit(item_id):
    """
    Edit an existing maintenance item.
    One sentence explanation: lets supervisors update due date, status or description for upcoming truck maintenance.
    """
    item = MaintenanceItem.query.get_or_404(item_id)

    if request.method == "POST":
        truck_id = request.form.get("truck_id", "").strip()
        due_date_str = request.form.get("due_date", "").strip()
        status = request.form.get("status", "").strip() or None
        description = request.form.get("description", "").strip() or None

        if not truck_id:
            flash("Truck ID is required.", "error")
        else:
            before = f"{item.truck_id} due={item.due_date} status={item.status}"
            item.truck_id = truck_id
            item.due_date = _parse_date(due_date_str)
            item.status = status
            item.description = description
            after = f"{item.truck_id} due={item.due_date} status={item.status}"
            db.session.flush()
            log_audit("maintenance", item.id, "update", f"{before} -> {after}")
            db.session.commit()
            flash("Maintenance item updated.", "success")
            return redirect(url_for("maintenance_page"))

    return render_template("maintenance_form.html", item=item, mode="edit")


@app.route("/api/maintenance/voice_status", methods=["POST"])
@require_role("supervisor", "admin")
def maintenance_voice_status():
    """
    Voice-triggered status update for a maintenance item.
    Expects JSON: { "truck_id": "...", "status": "..." }

    Finds the most recent MaintenanceItem for the given truck_id and
    updates its status, then logs an AuditLog entry.
    """

    data = request.get_json(silent=True) or {}
    truck_id_raw = (data.get("truck_id") or "").strip()
    status_raw = (data.get("status") or "").strip()

    if not truck_id_raw or not status_raw:
        return jsonify({"ok": False, "error": "truck_id and status required"}), 400

    item = (
        MaintenanceItem.query.filter(
            MaintenanceItem.truck_id.ilike(truck_id_raw)
        )
        .order_by(MaintenanceItem.id.desc())
        .first()
    )

    if not item:
        return jsonify({"ok": False, "error": f"No maintenance item found for truck {truck_id_raw}"}), 404

    old_status = item.status
    item.status = status_raw

    log_audit(
        "maintenance",
        item.id,
        "voice_status_update",
        f"Status changed from {old_status or 'None'} to {status_raw} for truck {item.truck_id} via voice",
    )
    db.session.commit()

    return jsonify(
        {
            "ok": True,
            "item": {
                "id": item.id,
                "truck_id": item.truck_id,
                "status": item.status,
            },
        }
    )


def render_machine_room_template():
    """
    Supervisor-only view with database and system overview.
    Shows table counts and a small sample of records.
    """

    uri = app.config["SQLALCHEMY_DATABASE_URI"]
    db_type = detect_db_type(uri)

    project_summary = load_project_summary()

    ensure_employee_table()

    employee_count = Employee.query.count()
    flight_count = Flight.query.count()
    maintenance_count = MaintenanceItem.query.count()
    audit_count = AuditLog.query.count()

    # New: global "last updated" from newest audit log row
    last_audit_entry = (
        AuditLog.query.order_by(AuditLog.timestamp.desc()).first()
    )
    last_updated_any = last_audit_entry.timestamp if last_audit_entry else None

    recent_employees = Employee.query.order_by(Employee.id.desc()).limit(5).all()
    recent_flights = (
        Flight.query.order_by(Flight.date.desc(), Flight.eta_local.desc())
        .limit(5)
        .all()
    )
    recent_maintenance = (
        MaintenanceItem.query.order_by(
            MaintenanceItem.due_date.is_(None), MaintenanceItem.due_date.asc()
        )
        .limit(5)
        .all()
    )
    recent_audit = (
        AuditLog.query.order_by(AuditLog.timestamp.desc())
        .limit(20)
        .all()
    )

    return render_template(
        "machine_room.html",
        db_type=db_type,
        db_uri=uri,
        employee_count=employee_count,
        flight_count=flight_count,
        maintenance_count=maintenance_count,
        audit_count=audit_count,
        project_summary=project_summary,
        recent_employees=recent_employees,
        recent_flights=recent_flights,
        recent_maintenance=recent_maintenance,
        recent_audit=recent_audit,
        last_updated_any=last_updated_any,
    )


@app.route("/machine-room")
@require_role("supervisor", "admin")
def machine_room():
    """Machine Room SPA entry point served from the React build."""

    return serve_frontend_spa()


@app.route("/legacy/machine-room")
@require_role("supervisor", "admin")
def legacy_machine_room():
    """Legacy Machine Room template for fallback access."""

    return render_machine_room_template()


@app.route("/settings")
@require_role("supervisor", "admin")
def settings_page():
    """
    Settings page showing current model and database configuration.
    One sentence explanation: renders settings.html with safe DB and model info.
    """

    uri = app.config["SQLALCHEMY_DATABASE_URI"]
    db_type = detect_db_type(uri)

    settings = {
        "db_type": db_type,
        "db_uri_preview": (uri[:60] + "…") if uri else "",
        "openai_model_build": os.getenv("OPENAI_MODEL_BUILD", "gpt-4o-mini"),
        "openai_model_fix": os.getenv("OPENAI_MODEL_FIX", "gpt-4o-mini"),
        "openai_model_know": os.getenv("OPENAI_MODEL_KNOW", "gpt-4o-mini"),
        "embed_model": os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small"),
    }

    return render_template("settings.html", settings=settings)


@app.route("/admin/dev-seed", methods=["POST"])
@require_role("supervisor", "admin")
def admin_dev_seed():
    """
    Dev-only endpoint to initialize and seed demo data for office views.

    Safe to run multiple times: seed scripts check for existing rows
    before inserting, and use db.create_all() under the hood.
    """
    import importlib

    try:
        # Import here to avoid circular imports at module load time
        seed_db = importlib.import_module("seed_db")
        office_seed = importlib.import_module("scripts.seed_office_data")

        # These functions already wrap their work in app.app_context()
        seed_db.seed()
        office_seed.seed_office_data()

        flash("Dev database seeded successfully.", "success")
    except Exception as exc:  # noqa: BLE001
        flash(f"Error seeding dev data: {exc}", "danger")

    return redirect(url_for("settings_page"))

# ----- API: Build -----
@app.route("/api/build/plan", methods=["POST"])
def api_build_plan():
    summary = request.form.get("summary", "")
    gen_tests = request.form.get("gen_tests") in ("on","true","1")
    package  = request.form.get("package_outputs") in ("on","true","1")
    res = orchestrator.plan(summary, gen_tests, package)
    return jsonify(res.__dict__)

@app.route("/api/build/scaffold", methods=["POST"])
def api_build_scaffold():
    res = orchestrator.scaffold()
    return jsonify(res.__dict__)

@app.route("/api/build/tests", methods=["POST"])
def api_build_tests():
    res = orchestrator.tests()
    return jsonify(res.__dict__)

@app.route("/api/build/package", methods=["POST"])
def api_build_package():
    res = orchestrator.package()
    zip_path = os.path.join(app.config["OUTPUTS_DIR"], "build.zip")
    with ZipFile(zip_path, "w", ZIP_DEFLATED) as z:
        for fn in os.listdir(app.config["OUTPUTS_DIR"]):
            fp = os.path.join(app.config["OUTPUTS_DIR"], fn)
            if os.path.isfile(fp):
                z.write(fp, arcname=fn)
    return jsonify(res.__dict__)

@app.route("/api/artifacts", methods=["GET"])
def api_artifacts():
    files = []
    for fn in sorted(os.listdir(app.config["OUTPUTS_DIR"])):
        path = os.path.join(app.config["OUTPUTS_DIR"], fn)
        if os.path.isfile(path):
            files.append({"name": fn, "size": os.path.getsize(path)})
    return jsonify({"files": files})

@app.route("/outputs/<path:filename>")
def serve_outputs(filename):
    return send_from_directory(app.config["OUTPUTS_DIR"], filename, as_attachment=False)

# ----- API: Fix -----
@app.route("/api/fix", methods=["POST"])
def api_fix():
    error_text = request.form.get("error") or ""
    snippet    = request.form.get("snippet") or ""
    criteria   = request.form.get("criteria") or ""
    report = fixer.generate_fix(error_text, snippet, criteria)
    return jsonify({"diff": report.diff, "risk_notes": report.risk_notes})

@app.route("/api/fix/apply", methods=["POST"])
def api_fix_apply():
    diff_text = request.form.get("diff") or ""
    ok = fixer.apply_patch(diff_text)
    return jsonify({"applied": ok})

# ----- API: Know -----
@app.route("/api/know", methods=["POST"])
def api_know():
    q = request.form.get("question") or ""
    ans = knower.ask(q)
    return jsonify({"answer": ans.answer, "sources": ans.sources})

@app.route('/healthz')
def healthz():
    return 'ok', 200


# --- Planner & Machine Room endpoints (added by Codex) ---


def _ops_parse_date(value: str):
    """Parse YYYY-MM-DD into a date object, or None on failure."""
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except Exception:  # noqa: BLE001
        return None


def _ops_parse_time(value: str):
    """Parse HH:MM into a time object, or None on failure."""
    if not value:
        return None
    try:
        return datetime.strptime(value, "%H:%M").time()
    except Exception:  # noqa: BLE001
        return None


def parse_scheduled_time(service_date: date, time_str: str | None, flight_number: str | None = None):
    """Convert a scheduled time string into a timezone-aware datetime.

    Returns ``None`` when the input is missing or malformed. Logs a warning so
    operators can spot upstream data issues without breaking imports.
    """

    if not time_str:
        return None

    try:
        hour_str, minute_str = time_str.split(":", maxsplit=1)
        hour = int(hour_str)
        minute = int(minute_str)
    except Exception as exc:  # noqa: BLE001
        app.logger.warning(
            "[import] Failed to parse scheduled time %s for %s: %s",
            time_str,
            flight_number or "unknown flight",
            exc,
        )
        return None

    try:
        return datetime(
            year=service_date.year,
            month=service_date.month,
            day=service_date.day,
            hour=hour,
            minute=minute,
            tzinfo=SYD_TZ,
        )
    except Exception as exc:  # noqa: BLE001
        app.logger.warning(
            "[import] Could not build datetime for %s (%s): %s",
            flight_number or "unknown flight",
            time_str,
            exc,
        )
        return None


def _time_from_value(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        localized = value if value.tzinfo else value.replace(tzinfo=SYD_TZ)
        return localized.astimezone(SYD_TZ).timetz()
    if isinstance(value, time):
        return value
    return None


def _ops_get_date_from_query(default_to_today: bool = True) -> date | None:
    """Parse ?date=YYYY-MM-DD from the query string.

    Falls back to today's date if missing/invalid and default_to_today is True.
    """
    dstr = request.args.get("date")
    d = _ops_parse_date(dstr)
    if d is None and default_to_today:
        return date.today()
    return d


def _format_time_for_display(value) -> str:
    time_val = _time_from_value(value)
    return time_val.strftime("%H:%M") if time_val else ""


@app.get("/api/flights")
def api_flights_for_date():
    """Return flights for a given date from the Office DB.

    Shape is compatible with the Planner:
      { "date": "YYYY-MM-DD", "flights": [ ... ] }
    """
    day = _ops_get_date_from_query()
    raw_airline = request.args.get("airline")
    if raw_airline is None:
        raw_airline = request.args.get("operator")

    airline_filter, error = parse_airline_filter(raw_airline)
    if error:
        return jsonify({"error": error}), 400

    try:
        query = Flight.query.filter(Flight.date == day)
        if airline_filter:
            query = query.filter(Flight.flight_number.ilike(f"{airline_filter}%"))

        flights = query.order_by(Flight.etd_local.asc(), Flight.eta_local.asc()).all()

        payload: list[dict] = []
        for f in flights:
            etd_local = f.etd_local
            if isinstance(etd_local, datetime) and etd_local.tzinfo is None:
                etd_local = etd_local.replace(tzinfo=SYD_TZ)

            time_val = etd_local or f.eta_local
            time_local = _format_time_for_display(time_val)
            airline = "".join(ch for ch in (f.flight_number or "") if ch.isalpha())[:3] or "UNK"

            payload.append(
                {
                    "id": f.id,
                    "flight_number": f.flight_number,
                    "destination": f.destination,
                    "origin": f.origin,
                    "time_local": time_local,
                    "etd_local": etd_local.isoformat() if etd_local else None,
                    "operator_code": airline,
                    "aircraft_type": None,
                    "assigned_employee_id": f.assigned_employee_id,
                    "assigned_employee_name": f.assigned_employee_name,
                    "assigned_truck": f.assigned_truck,
                    "notes": f.notes or "",
                }
            )

        return jsonify({"date": day.isoformat(), "flights": payload}), 200

    except Exception as exc:  # noqa: BLE001
        app.logger.exception("/api/flights failed for date=%s airline=%s", day, airline_filter)
        return (
            jsonify(
                {
                    "error": "Internal error while fetching flights.",
                    "date": day.isoformat() if day else None,
                    "airline": airline_filter,
                }
            ),
            500,
        )


@app.post("/api/flights/import")
def api_flights_import():
    """Import a JSON payload of flights into the Flight table.

    Expected body:
    {
      "date": "YYYY-MM-DD",
      "flights": [
        { "flight_number": "JQ123", "destination": "MEL", "origin": "SYD", "time_local": "08:15", ... }
      ]
    }
    """
    data = request.get_json(silent=True) or {}
    day = _ops_parse_date(data.get("date")) or date.today()
    flights_in = data.get("flights") or []

    created = 0
    for row in flights_in:
        flight_number = (row.get("flight_number") or "").strip()
        if not flight_number:
            continue

        time_str = (row.get("time_local") or "").strip()
        time_val = parse_scheduled_time(day, time_str)

        airline = row.get("airline") or "".join(ch for ch in flight_number if ch.isalpha())[:3]
        registration = row.get("registration") or row.get("rego")

        f = Flight(
            flight_number=flight_number,
            airline=airline or None,
            date=day,
            imported_at=syd_now(),
            origin=row.get("origin") or None,
            destination=row.get("destination") or None,
            eta_local=None,
            etd_local=time_val,
            registration=registration or None,
            tail_number=row.get("tail_number") or None,
            truck_assignment=None,
            status=row.get("status") or "scheduled",
            notes=row.get("notes") or None,
        )
        db.session.add(f)
        created += 1

    db.session.commit()
    return jsonify({"ok": True, "imported": created, "date": day.isoformat()}), 201


@app.get("/api/roster/daily")
def api_roster_daily():
    date_str = request.args.get("date")
    if not date_str:
        return json_error(
            "date is required", status_code=400, error_type="validation_error"
        )

    try:
        target_date = date.fromisoformat(date_str)
    except Exception:
        return json_error(
            "Invalid date format; expected YYYY-MM-DD.",
            status_code=400,
            error_type="validation_error",
            context={"date": date_str},
        )

    try:
        ensure_roster_schema()
        roster = get_daily_roster(target_date)
        return jsonify({"ok": True, "roster": roster})
    except ValueError as exc:
        return json_error(
            str(exc),
            status_code=400,
            error_type="validation_error",
            context={"date": target_date.isoformat()},
        )
    except Exception:  # noqa: BLE001
        app.logger.exception("Failed to build daily roster")
        return json_error(
            "Internal error while building roster.",
            context={"date": target_date.isoformat()},
        )


@app.post("/api/roster/load_seed")
def api_roster_load_seed():
    """Proxy to CodeCrafter2 to load seed staff + roster templates."""

    try:
        upstream_resp = requests.post(
            f"{CODECRAFTER_BASE}/api/roster/load_seed", timeout=60
        )
    except requests.RequestException as exc:
        app.logger.exception("Failed to call CodeCrafter2 roster seed endpoint")
        return jsonify({"ok": False, "error": f"Failed to load roster seed: {exc}"}), 502

    try:
        payload = upstream_resp.json()
    except ValueError:
        payload = None

    if not upstream_resp.ok:
        message = None
        if isinstance(payload, dict):
            message = payload.get("error") or payload.get("message")
        message = message or upstream_resp.text or "Upstream roster seed failed"
        return (
            jsonify({"ok": False, "error": message}),
            upstream_resp.status_code or 502,
        )

    return jsonify(payload or {"ok": True}), upstream_resp.status_code


@app.post("/api/roster/generate")
def api_generate_roster_from_template():
    payload = request.get_json(silent=True) or {}
    start_date = _ops_parse_date(payload.get("start_date") or payload.get("date"))
    end_date = _ops_parse_date(payload.get("end_date")) or start_date

    if not start_date:
        return json_error(
            "start_date is required", status_code=400, error_type="validation_error"
        )

    if end_date is None:
        end_date = start_date

    try:
        ensure_roster_schema()
        summary = generate_roster_for_date_range(start_date, end_date)
        return (
            jsonify(
                {
                    "ok": True,
                    "start_date": start_date.isoformat(),
                    "end_date": end_date.isoformat(),
                    **summary,
                }
            ),
            200,
        )
    except Exception:  # noqa: BLE001
        app.logger.exception("Failed to generate roster entries")
        return json_error(
            "Failed to generate roster entries.",
            context={
                "endpoint": "/api/roster/generate",
                "start_date": start_date.isoformat(),
                "end_date": end_date.isoformat(),
            },
        )


@app.post("/api/employee_assignments/generate")
def api_employee_assignments_generate():
    payload = request.get_json(silent=True) or {}
    date_str = payload.get("date")
    airline = (payload.get("airline") or DEFAULT_AIRLINE).upper()

    context = {"endpoint": "/api/employee_assignments/generate", "airline": airline}

    if not date_str:
        return json_error(
            "date is required", status_code=400, error_type="validation_error", context=context
        )

    try:
        target_date = date.fromisoformat(date_str)
    except Exception:
        context["date"] = date_str
        return json_error(
            "Invalid date format; expected YYYY-MM-DD.",
            status_code=400,
            error_type="validation_error",
            context=context,
        )

    context["date"] = target_date.isoformat()

    if airline not in SUPPORTED_AIRLINES:
        return json_error(
            f"Unsupported airline {airline}.",
            status_code=400,
            error_type="validation_error",
            context=context,
        )

    try:
        ensure_flight_schema()
        ensure_roster_schema()
        summary = auto_assign_employees_for_date(target_date, airline)
        payload = {"ok": True, **summary}
        app.logger.info(
            "employee assignments generated for %s %s: %s assigned, %s unassigned",
            airline,
            target_date.isoformat(),
            summary.get("assigned"),
            summary.get("unassigned"),
        )
        return jsonify(payload), 200
    except Exception:  # noqa: BLE001
        db.session.rollback()
        app.logger.exception("Auto-assign employees failed")
        return json_error(
            "Internal error while assigning employees to flights.",
            context=context,
        )


@app.post("/api/runs/generate")
def api_generate_runs():
    """Generate runs for the requested date and airline."""

    day = _ops_get_date_from_query(default_to_today=False)
    if day is None:
        return json_error("date is required", status_code=400, error_type="validation_error")

    airline, error = parse_airline_filter(request.args.get("airline"), allow_all=False)
    if error:
        return json_error(error, status_code=400, error_type="validation_error")
    if not airline:
        airline = DEFAULT_AIRLINE

    try:
        ensure_runs_schema()
        summary = generate_runs_for_date_airline(day, airline)
        summary["ok"] = True
        return jsonify(summary)
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("runs.generate failed")
        return json_error(
            "Internal error while generating runs.",
            status_code=500,
            error_type="runs_error",
            context={"date": day.isoformat(), "airline": airline, "detail": str(exc)},
        )


@app.post("/api/staff_runs/generate")
def api_generate_staff_runs():
    """Generate staff runs for the requested date and airline."""

    day = _ops_get_date_from_query(default_to_today=False)
    if day is None:
        return json_error("date is required", status_code=400, error_type="validation_error")

    airline, error = parse_airline_filter(request.args.get("airline"), allow_all=False)
    if error:
        return json_error(error, status_code=400, error_type="validation_error")
    if not airline:
        return json_error(
            "airline is required",
            status_code=400,
            error_type="validation_error",
            context={"date": day.isoformat()},
        )

    try:
        from services.staff_runs import generate_staff_runs_for_date_airline

        ensure_flight_schema()
        ensure_roster_schema()
        ensure_staff_run_schema()
        summary = generate_staff_runs_for_date_airline(day, airline)
        return jsonify({"ok": True, "summary": summary})
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("staff runs.generate failed")
        return json_error(
            "Internal error while generating staff runs.",
            status_code=500,
            error_type="staff_runs_error",
            context={"date": day.isoformat(), "airline": airline, "detail": str(exc)},
        )


@app.get("/api/runs")
def api_runs_for_date():
    """Return runs with their flights for the requested date and airline."""

    day = _ops_get_date_from_query(default_to_today=False)
    if day is None:
        return json_error("date is required", status_code=400, error_type="validation_error")

    airline, error = parse_airline_filter(request.args.get("airline"), allow_all=False)
    if error:
        return json_error(error, status_code=400, error_type="validation_error")
    if not airline:
        airline = DEFAULT_AIRLINE

    try:
        ensure_runs_schema()
        runs_payload = get_runs_for_date_airline(day, airline)
        runs_payload["ok"] = True
        return jsonify(runs_payload)
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("runs.fetch failed")
        return json_error(
            "Internal error while fetching runs.",
            status_code=500,
            error_type="runs_error",
            context={"date": day.isoformat(), "airline": airline, "detail": str(exc)},
        )


@app.get("/api/staff_runs")
def api_staff_runs_for_date():
    """Return staff runs and unassigned flights for the requested date and airline."""

    day = _ops_get_date_from_query(default_to_today=False)
    if day is None:
        return json_error("date is required", status_code=400, error_type="validation_error")

    airline, error = parse_airline_filter(request.args.get("airline"), allow_all=False)
    if error:
        return json_error(error, status_code=400, error_type="validation_error")
    if not airline:
        return json_error(
            "airline is required",
            status_code=400,
            error_type="validation_error",
            context={"date": day.isoformat()},
        )

    try:
        from services.staff_runs import get_staff_runs_for_date_airline

        ensure_flight_schema()
        ensure_staff_run_schema()
        runs_payload = get_staff_runs_for_date_airline(day, airline)
        return jsonify({"ok": True, **runs_payload})
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("staff runs.fetch failed")
        return json_error(
            "Internal error while fetching staff runs.",
            status_code=500,
            error_type="staff_runs_error",
            context={"date": day.isoformat(), "airline": airline, "detail": str(exc)},
        )


def _flight_matches_airline_code(flight, airline: str) -> bool:
    if flight.airline and flight.airline.upper() == airline:
        return True
    return (flight.flight_number or "").upper().startswith(airline)


@app.get("/api/runs_status")
def api_runs_status():
    day = _ops_get_date_from_query(default_to_today=False)
    if day is None:
        return json_error("date is required", status_code=400, error_type="validation_error")

    try:
        ensure_flight_schema()
        ensure_staff_run_schema()

        flights = Flight.query.filter(Flight.date == day).all()
        runs = StaffRun.query.filter(StaffRun.date == day).all()
        jobs = (
            StaffRunJob.query.join(StaffRun)
            .filter(StaffRun.date == day)
            .options(db.joinedload(StaffRunJob.staff_run))
            .all()
        )

        flights_by_airline: dict[str, list[Flight]] = {code: [] for code in SUPPORTED_AIRLINES}
        for flight in flights:
            for code in SUPPORTED_AIRLINES:
                if _flight_matches_airline_code(flight, code):
                    flights_by_airline.setdefault(code, []).append(flight)
                    break

        runs_by_airline: dict[str, list[StaffRun]] = {code: [] for code in SUPPORTED_AIRLINES}
        for run in runs:
            runs_by_airline.setdefault(run.airline, []).append(run)

        jobs_by_airline: dict[str, list[StaffRunJob]] = {code: [] for code in SUPPORTED_AIRLINES}
        for job in jobs:
            if job.staff_run and job.staff_run.airline:
                jobs_by_airline.setdefault(job.staff_run.airline, []).append(job)

        airlines_summary = []
        for airline in SUPPORTED_AIRLINES_ORDERED:
            airline_flights = flights_by_airline.get(airline, [])
            airline_runs = runs_by_airline.get(airline, [])
            airline_jobs = jobs_by_airline.get(airline, [])

            assigned_flight_ids = {job.flight_id for job in airline_jobs if job.flight_id is not None}
            unassigned = len(
                [flight for flight in airline_flights if flight.id not in assigned_flight_ids]
            )

            airlines_summary.append(
                {
                    "airline": airline,
                    "flights": len(airline_flights),
                    "runs": len(airline_runs),
                    "jobs": len(airline_jobs),
                    "unassigned": unassigned,
                }
            )

        return jsonify({"ok": True, "date": day.isoformat(), "airlines": airlines_summary})
    except Exception as exc:  # noqa: BLE001
        app.logger.exception("runs status fetch failed")
        return json_error(
            "Internal error while fetching runs status.",
            status_code=500,
            error_type="staff_runs_error",
            context={"date": day.isoformat(), "detail": str(exc)},
        )


@app.post("/api/flight_runs/assign")
def api_assign_flight_run():
    data = request.get_json(silent=True) or {}
    run_id = data.get("run_id")
    flight_id = data.get("flight_id")
    if run_id is None or flight_id is None:
        return json_error("run_id and flight_id are required", status_code=400, error_type="validation_error")

    try:
        ensure_runs_schema()
        run = Run.query.get(run_id)
        flight = Flight.query.get(flight_id)
        if not run or not flight:
            return json_error("run or flight not found", status_code=404, error_type="not_found")
        if run.date != flight.date:
            return json_error(
                "Run and flight must be on the same date",
                status_code=400,
                error_type="validation_error",
                context={"run_date": run.date.isoformat(), "flight_date": flight.date.isoformat()},
            )

        # Remove any existing assignments for this flight
        RunFlight.query.filter_by(flight_id=flight.id).delete(synchronize_session=False)

        max_index = (
            db.session.query(db.func.max(RunFlight.sequence_index))
            .filter(RunFlight.run_id == run.id)
            .scalar()
        )
        next_index = 0 if max_index is None else max_index + 1

        rf = RunFlight(
            run_id=run.id,
            flight_id=flight.id,
            sequence_index=next_index,
            planned_time=(flight.etd_local or run.start_time).time() if (flight.etd_local or run.start_time) else None,
            status="planned",
        )
        db.session.add(rf)
        db.session.commit()
        return jsonify({"ok": True, "run_flight_id": rf.id})
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        app.logger.exception("flight_runs.assign failed")
        return json_error("Failed to assign flight to run", error_type="assignment_error", context={"detail": str(exc)})


@app.post("/api/runs/update_layout")
def api_runs_update_layout():
    payload = request.get_json(silent=True) or {}
    date_str = payload.get("date")
    runs_data = payload.get("runs") or []
    if not date_str:
        return json_error("date is required", status_code=400, error_type="validation_error")

    try:
        day = date.fromisoformat(date_str)
    except Exception:
        return json_error("Invalid date format", status_code=400, error_type="validation_error")

    try:
        ensure_runs_schema()
        updated = 0
        seen_ids = set()

        for run_entry in runs_data:
            run_id = run_entry.get("id")
            flight_run_ids = run_entry.get("flight_run_ids") or []
            run = Run.query.get(run_id)
            if not run:
                continue
            if run.date != day:
                continue

            seen_ids.update(flight_run_ids)
            for seq, fr_id in enumerate(flight_run_ids):
                rf = RunFlight.query.get(fr_id)
                if not rf:
                    continue
                rf.run_id = run.id
                rf.sequence_index = seq
                rf.position = seq
                updated += 1
            # Remove any run flights for this run/date that are not mentioned
            RunFlight.query.filter(RunFlight.run_id == run.id, RunFlight.id.notin_(flight_run_ids)).delete(synchronize_session=False)

        # Remove stray run flights on this date that were not referenced
        RunFlight.query.filter(
            RunFlight.id.notin_(seen_ids),
            RunFlight.run.has(Run.date == day),
        ).delete(synchronize_session=False)

        db.session.commit()
        return jsonify({"ok": True, "updated_flight_runs": updated})
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        app.logger.exception("runs.update_layout failed")
        return json_error(
            "Failed to update run layout",
            error_type="runs_error",
            context={"date": date_str, "detail": str(exc)},
        )


def _find_service_window(flight: Flight, profiles: dict[str, ServiceProfile]):
    profile_code = getattr(flight, "service_profile_code", None)
    profile = profiles.get(profile_code) if profile_code else None
    etd_dt = flight.etd_local or flight.eta_local
    if not etd_dt:
        return None

    start_offset = profile.window_start_mins if profile and profile.window_start_mins is not None else -45
    end_offset = profile.window_end_mins if profile and profile.window_end_mins is not None else 45
    start_dt = etd_dt + timedelta(minutes=start_offset)
    end_dt = etd_dt + timedelta(minutes=end_offset)
    return start_dt, end_dt


@app.post("/api/assignments/generate")
def api_assignments_generate():
    payload = request.get_json(silent=True) or {}
    date_str = payload.get("date")
    respect_existing = bool(payload.get("respect_existing_runs", False))
    if not date_str:
        return json_error("date is required", status_code=400, error_type="validation_error")

    try:
        target_date = date.fromisoformat(date_str)
    except Exception:
        return json_error("Invalid date format", status_code=400, error_type="validation_error")

    try:
        ensure_runs_schema()
        flights = Flight.query.filter(Flight.date == target_date).all()
        runs = Run.query.filter(Run.date == target_date).options(db.selectinload(Run.run_flights)).all()
        profiles = {p.code: p for p in ServiceProfile.query.all()}

        assigned = 0
        unassigned = 0
        unprofiled = 0

        # Build existing mapping if respecting
        if respect_existing:
            existing_flight_ids = {rf.flight_id for r in runs for rf in r.run_flights}
        else:
            RunFlight.query.filter(RunFlight.run.has(Run.date == target_date)).delete(synchronize_session=False)
            existing_flight_ids = set()

        for flight in flights:
            if respect_existing and flight.id in existing_flight_ids:
                continue

            window = _find_service_window(flight, profiles)
            if not window:
                unprofiled += 1
                continue

            start_dt, end_dt = window
            placed = False
            for run in runs:
                if run.start_time and run.end_time:
                    if start_dt >= run.start_time and end_dt <= run.end_time:
                        pass
                    elif end_dt < run.start_time or start_dt > run.end_time:
                        continue
                if run.airline and flight.airline and run.airline != flight.airline:
                    continue

                max_index = (
                    db.session.query(db.func.max(RunFlight.sequence_index))
                    .filter(RunFlight.run_id == run.id)
                    .scalar()
                )
                next_index = 0 if max_index is None else max_index + 1
                rf = RunFlight(
                    run_id=run.id,
                    flight_id=flight.id,
                    sequence_index=next_index,
                    planned_time=(flight.etd_local or flight.eta_local).time() if (flight.etd_local or flight.eta_local) else None,
                    status="planned",
                )
                db.session.add(rf)
                assigned += 1
                placed = True
                break

            if not placed:
                unassigned += 1

        db.session.commit()
        return jsonify({
            "ok": True,
            "date": target_date.isoformat(),
            "assigned": assigned,
            "unassigned": unassigned,
            "unprofiled": unprofiled,
        })
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        app.logger.exception("assignments.generate failed")
        return json_error(
            "Failed to auto-assign flights",
            error_type="assignment_error",
            context={"date": date_str, "detail": str(exc)},
        )


@app.get("/api/status")
def api_status():
    """Backend + DB health snapshot for Machine Room.

    Summarises flights by AM/PM and airline and includes a lightweight runs
    summary.
    """
    day = _ops_get_date_from_query()
    airline_filter, error = parse_airline_filter(request.args.get("airline"))
    if error:
        return jsonify({"ok": False, "database_ok": False, "error": error}), 400

    db_ok = True
    flights_summary = {
        "total": 0,
        "am_total": 0,
        "pm_total": 0,
        "by_airline": {},
        "assigned": 0,
        "unassigned": 0,
    }
    runs_summary = {"total": 0, "with_flights": 0, "unassigned_flights": 0}

    flights: list[Flight] = []

    try:
        query = Flight.query.filter(Flight.date == day)
        if airline_filter:
            query = query.filter(Flight.flight_number.ilike(f"{airline_filter}%"))

        flights = query.all()
        flights_summary["total"] = len(flights)
        flights_summary["assigned"] = len([f for f in flights if f.assigned_employee_name])
        flights_summary["unassigned"] = flights_summary["total"] - flights_summary["assigned"]

        for f in flights:
            time_val = _time_from_value(f.etd_local or f.eta_local)
            mins = None
            if time_val:
                mins = time_val.hour * 60 + time_val.minute

            airline = "".join(ch for ch in (f.flight_number or "") if ch.isalpha())[:3] or "UNK"
            flights_summary["by_airline"].setdefault(airline, 0)
            flights_summary["by_airline"][airline] += 1

            if mins is None:
                continue
            if 5 * 60 <= mins <= 12 * 60:
                flights_summary["am_total"] += 1
            elif 12 * 60 + 1 <= mins <= 23 * 60:
                flights_summary["pm_total"] += 1
    except Exception:  # noqa: BLE001
        db.session.rollback()
        db_ok = False
        app.logger.exception("[status] Flights query failed")

    try:
        runs_query = Run.query.filter(Run.date == day)
        if airline_filter:
            runs_query = runs_query.filter(Run.airline == airline_filter)
        runs = runs_query.options(db.selectinload(Run.run_flights)).all()
        runs_summary["total"] = len(runs)
        runs_summary["with_flights"] = sum(1 for r in runs if r.run_flights)

        assigned_flight_ids = {rf.flight_id for r in runs for rf in r.run_flights}
        runs_summary["unassigned_flights"] = len(
            [f for f in flights if f.id not in assigned_flight_ids]
        )
    except Exception:  # noqa: BLE001
        db.session.rollback()
        app.logger.exception("[status] Runs query failed")
        runs_summary["error"] = "runs_unavailable"

    runs_supported = "error" not in runs_summary

    payload = {
        "ok": db_ok,
        "database_ok": db_ok,
        "date": day.isoformat(),
        "airline": airline_filter,
        "timestamp": datetime.utcnow().isoformat() + "Z",
        "flights": flights_summary,
        "runs": runs_summary,
        "runs_supported": runs_supported,
    }
    return jsonify(payload)


@app.cli.command("generate-roster")
@click.option("--start-date", "start_date_str", required=True)
@click.option("--end-date", "end_date_str")
def cli_generate_roster(start_date_str: str, end_date_str: str | None):
    """Generate dated roster entries from the weekly template."""

    with app.app_context():
        ensure_roster_schema()
        start_date = date.fromisoformat(start_date_str)
        end_date = date.fromisoformat(end_date_str) if end_date_str else start_date
        summary = generate_roster_for_date_range(start_date, end_date)
        click.echo(json.dumps(summary))


@app.cli.command("auto-assign-employees")
@click.option("--date", "target_date_str", required=True)
@click.option("--airline", default=DEFAULT_AIRLINE)
def cli_auto_assign(target_date_str: str, airline: str):
    """Assign rostered employees to flights for the given date/airline."""

    with app.app_context():
        ensure_flight_schema()
        ensure_roster_schema()
        target_date = date.fromisoformat(target_date_str)
        summary = auto_assign_employees_for_date(target_date, airline)
        click.echo(json.dumps(summary))

if __name__ == "__main__":
    app.run(debug=True)


