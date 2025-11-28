import os
import json
import datetime as dt
from datetime import datetime
from functools import wraps
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

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
from werkzeug.security import check_password_hash, generate_password_hash

from dotenv import load_dotenv

load_dotenv()  # loads OPENAI_API_KEY, FLASK_SECRET_KEY, etc.

from config import CODE_CRAFTER2_API_BASE
from services.orchestrator import BuildOrchestrator
from services.fixer import FixService
from services.knowledge import KnowledgeService
from services.importer import ImportService
from scripts.schema_utils import ensure_flight_columns
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

SUPPORTED_ROLES = ("admin", "supervisor", "refueler", "viewer")
ROLE_CHOICES = ("admin", "supervisor", "refueler", "viewer")

BASE_DIR = Path(__file__).parent
FRONTEND_BUILD_DIR = BASE_DIR / "frontend_dist"


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


_PROJECT_SUMMARY_CACHE = None
_PROJECT_SUMMARY_PATH = Path(__file__).parent / "TheBrain" / "project_summary.json"


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
    name = db.Column(db.String(80), nullable=False)
    role = db.Column(db.String(80), nullable=False)
    shift = db.Column(db.String(40), nullable=False)
    base = db.Column(db.String(40), nullable=True)
    active = db.Column(db.Boolean, default=True)


class Flight(db.Model):
    __tablename__ = "flights"

    id = db.Column(db.Integer, primary_key=True)
    flight_number = db.Column(db.String(32), nullable=False)
    time_local = db.Column(db.Time, nullable=True)
    date = db.Column(db.Date, nullable=False)
    origin = db.Column(db.String(32), nullable=True)
    destination = db.Column(db.String(32), nullable=True)
    operator_code = db.Column(db.String(16), nullable=True)
    aircraft_type = db.Column(db.String(32), nullable=True)
    service_profile_code = db.Column(db.String(64), nullable=True)
    bay = db.Column(db.String(32), nullable=True)
    registration = db.Column(db.String(32), nullable=True)
    status_code = db.Column(db.String(16), nullable=True)
    is_international = db.Column(db.Boolean, nullable=False, default=False)
    eta_local = db.Column(db.Time, nullable=True)
    etd_local = db.Column(db.Time, nullable=True)
    tail_number = db.Column(db.String(32), nullable=True)
    truck_assignment = db.Column(db.String(64), nullable=True)
    status = db.Column(db.String(32), nullable=True)
    notes = db.Column(db.Text, nullable=True)


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


def _parse_bool(val):
    if isinstance(val, bool):
        return val
    if val is None:
        return None
    s = str(val).strip().lower()
    if s in ("true", "1", "yes", "y", "on"):
        return True
    if s in ("false", "0", "no", "n", "off"):
        return False
    return None


def flight_to_dict(f: Flight) -> dict:
    return {
        "id": f.id,
        "flight_number": f.flight_number,
        "date": f.date.strftime("%Y-%m-%d") if f.date else None,
        "time_local": f.time_local.strftime("%H:%M") if f.time_local else None,
        "origin": f.origin,
        "destination": f.destination,
        "operator_code": f.operator_code,
        "aircraft_type": f.aircraft_type,
        "service_profile_code": f.service_profile_code,
        "bay": f.bay,
        "registration": f.registration,
        "status_code": f.status_code,
        "is_international": bool(f.is_international) if f.is_international is not None else False,
        "eta_local": f.eta_local.strftime("%H:%M") if f.eta_local else None,
        "etd_local": f.etd_local.strftime("%H:%M") if f.etd_local else None,
        "tail_number": f.tail_number,
        "truck_assignment": f.truck_assignment,
        "status": f.status,
        "notes": f.notes,
    }


def ensure_flight_schema():
    """Create tables and ensure the flights schema carries the new columns."""

    try:
        db.create_all()
        ensure_flight_columns(db.engine)
    except Exception as exc:  # noqa: BLE001
        # Never crash app startup on schema adjustments; log and continue.
        print(f"[schema] Unable to ensure flight columns: {exc}")


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

# Ensure the latest Flight schema exists on startup (no-op if already applied)
with app.app_context():
    ensure_flight_schema()

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
    employees = Employee.query.order_by(Employee.name.asc()).all()
    return render_template("employees.html", employees=employees)


@app.route("/employees/new", methods=["GET", "POST"])
@requires_supervisor
def employee_create():
    """
    Create a new employee (crew member).
    GET: render empty form.
    POST: validate fields and insert Employee row.
    """
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        role = request.form.get("role", "").strip()
        shift = request.form.get("shift", "").strip()
        base = request.form.get("base", "").strip()
        active = request.form.get("active") == "on"

        if not name or not role or not shift:
            flash("Name, role and shift are required.", "error")
        else:
            emp = Employee(
                name=name,
                role=role,
                shift=shift,
                base=base or None,
                active=active,
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

    if request.method == "POST":
        name = request.form.get("name", "").strip()
        role = request.form.get("role", "").strip()
        shift = request.form.get("shift", "").strip()
        base = request.form.get("base", "").strip()
        active = request.form.get("active") == "on"

        if not name or not role or not shift:
            flash("Name, role and shift are required.", "error")
        else:
            before = f"{emp.name} role={emp.role} shift={emp.shift} base={emp.base} active={emp.active}"
            emp.name = name
            emp.role = role
            emp.shift = shift
            emp.base = base or None
            emp.active = active
            after = f"{emp.name} role={emp.role} shift={emp.shift} base={emp.base} active={emp.active}"
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
            eta_val = _parse_time(eta_str)
            etd_val = _parse_time(etd_str)

            if not date_val:
                flash("Invalid date format.", "error")
            else:
                f = Flight(
                    flight_number=flight_number,
                    time_local=eta_val or etd_val,
                    date=date_val,
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
            eta_val = _parse_time(eta_str)
            etd_val = _parse_time(etd_str)

            if not date_val:
                flash("Invalid date format.", "error")
            else:
                before = (
                    f"{f.flight_number} date={f.date} eta={f.eta_local} "
                    f"origin={f.origin} destination={f.destination}"
                )
                f.flight_number = flight_number
                f.date = date_val
                f.time_local = eta_val or etd_val
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

    eta_value = f.eta_local.strftime("%H:%M") if f.eta_local else ""
    etd_value = f.etd_local.strftime("%H:%M") if f.etd_local else ""
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

    # Ensure the flights table has the latest columns before inserting rows
    ensure_flight_columns(db.engine)

    errors = 0
    imported = 0

    for row in batch.rows:
        if not row.is_valid:
            errors += 1
            continue

        data = row.data or {}
        try:
            if batch.import_type == "flights":
                time_val = _parse_time(
                    data.get("time_local") or data.get("eta_local") or data.get("etd_local")
                )
                is_international = _parse_bool(data.get("is_international"))
                f = Flight(
                    flight_number=data.get("flight_number", "").strip(),
                    time_local=time_val,
                    date=_parse_date(data.get("date")),
                    origin=data.get("origin"),
                    destination=data.get("destination"),
                    operator_code=data.get("operator_code"),
                    aircraft_type=data.get("aircraft_type"),
                    service_profile_code=data.get("service_profile_code"),
                    bay=data.get("bay"),
                    registration=data.get("registration"),
                    status_code=data.get("status_code") or data.get("status"),
                    is_international=is_international if is_international is not None else False,
                    eta_local=time_val or _parse_time(data.get("eta_local")),
                    etd_local=_parse_time(data.get("etd_local")),
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
        Flight.query.order_by(Flight.date.desc(), Flight.time_local.desc(), Flight.eta_local.desc())
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
    """
    Machine Room — Jinja template inside the shared CodeCrafter layout.

    One sentence explanation: shows DB stats, recent activity, and project
    summary using machine_room.html.
    """

    return render_machine_room_template()


@app.route("/machine-room-react")
@require_role("supervisor", "admin")
def machine_room_react():
    """
    Machine Room React SPA entry point served from the built frontend.

    One sentence explanation: serves frontend_dist/index.html for React-based
    Machine Room experiments.
    """

    return serve_frontend_spa()


@app.route("/legacy/machine-room")
@require_role("supervisor", "admin")
def legacy_machine_room():
    """Legacy alias for the Machine Room template."""

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


# ----- API: Flights -----


@app.route("/api/flights", methods=["GET"])
@require_role("refueler", "supervisor", "admin")
def api_flights():
    """Return flights for a specific date as JSON for the SPA views."""

    ensure_flight_schema()

    date_str = request.args.get("date")
    if not date_str:
        return jsonify({"ok": False, "error": "date query param is required"}), 400

    date_val = _parse_date(date_str)
    if not date_val:
        return jsonify({"ok": False, "error": "Invalid date format"}), 400

    flights = (
        Flight.query.filter(Flight.date == date_val)
        .order_by(Flight.time_local.asc(), Flight.eta_local.asc(), Flight.flight_number.asc())
        .all()
    )

    return jsonify({"ok": True, "flights": [flight_to_dict(f) for f in flights]})


@app.route("/api/flights/import", methods=["POST"])
@require_role("supervisor", "admin")
def api_import_flights():
    """Import flights (idempotent upsert) from JSON payloads."""

    ensure_flight_schema()

    payload = request.get_json(silent=True) or {}
    base_date = payload.get("date")
    flights_data = payload.get("flights")

    if flights_data is None:
        if isinstance(payload, list):
            flights_data = payload
        else:
            flights_data = [payload]

    if not isinstance(flights_data, list):
        return jsonify({"ok": False, "error": "flights must be a list"}), 400

    created = 0
    updated = 0
    errors: list[str] = []

    for idx, row in enumerate(flights_data, start=1):
        if not isinstance(row, dict):
            errors.append(f"Row {idx} is not an object")
            continue

        flight_number = (row.get("flight_number") or "").strip()
        dest = (row.get("destination") or "").strip()
        date_val = _parse_date(row.get("date") or base_date)
        time_val = _parse_time(row.get("time_local") or row.get("time"))

        if not flight_number or not dest or not date_val:
            errors.append(f"Row {idx} missing required fields (flight_number, destination, date)")
            continue

        operator_code = (row.get("operator_code") or "").strip() or None
        aircraft_type = (row.get("aircraft_type") or "").strip() or None
        service_profile_code = (row.get("service_profile_code") or "").strip() or None
        bay = (row.get("bay") or "").strip() or None
        registration = (row.get("registration") or "").strip() or None
        status_code = (row.get("status_code") or row.get("status") or "").strip() or None
        is_international = _parse_bool(row.get("is_international"))

        eta_val = time_val or _parse_time(row.get("eta_local"))
        etd_val = _parse_time(row.get("etd_local"))

        existing = (
            Flight.query.filter(
                Flight.date == date_val,
                Flight.flight_number == flight_number,
                Flight.time_local == time_val,
            )
            .order_by(Flight.id.asc())
            .first()
        )

        if existing:
            f = existing
            updated += 1
        else:
            f = Flight(flight_number=flight_number, date=date_val)
            created += 1
            db.session.add(f)

        f.time_local = time_val
        f.origin = (row.get("origin") or "").strip() or None
        f.destination = dest
        f.operator_code = operator_code
        f.aircraft_type = aircraft_type
        f.service_profile_code = service_profile_code
        f.bay = bay
        f.registration = registration
        f.status_code = status_code
        f.is_international = is_international if is_international is not None else False
        f.eta_local = eta_val
        f.etd_local = etd_val
        f.tail_number = (row.get("tail_number") or "").strip() or None
        f.truck_assignment = (row.get("truck_assignment") or "").strip() or None
        f.status = (row.get("status") or "").strip() or None
        f.notes = (row.get("notes") or "").strip() or None

    db.session.commit()

    return jsonify({"ok": True, "created": created, "updated": updated, "errors": errors})


@app.route("/api/dev/seed_dec24_schedule", methods=["POST"])
@require_role("admin")
def api_seed_dec24_schedule():
    """Dev helper to seed the canonical Dec24 schedule."""

    ensure_flight_schema()

    date_filter = request.args.get("date")
    wipe = request.args.get("wipe") in ("1", "true", "yes", "on")

    try:
        from dev_seed_dec24_schedule import seed_dec24_schedule

        with app.app_context():
            result = seed_dec24_schedule(date_filter=date_filter, wipe=wipe)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(exc)}), 500

    return jsonify({"ok": True, "date": date_filter, **result})

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

if __name__ == "__main__":
    app.run(debug=True)


