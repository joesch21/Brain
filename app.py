import os
import json
import datetime as dt
from datetime import datetime
from functools import wraps
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
)
from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import check_password_hash, generate_password_hash

TRUCKS = [
    {"id": "Truck-1", "next_maintenance": "2025-12-05", "status": "OK"},
    {"id": "Truck-2", "next_maintenance": "2025-12-03", "status": "Due"},
    {"id": "Truck-3", "next_maintenance": "2025-12-10", "status": "OK"},
]

from dotenv import load_dotenv

load_dotenv()  # loads OPENAI_API_KEY, FLASK_SECRET_KEY, etc.

from services.orchestrator import BuildOrchestrator
from services.fixer import FixService
from services.knowledge import KnowledgeService
from services.importer import ImportService

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

SUPPORTED_ROLES = ("admin", "supervisor", "refueler", "viewer")
ROLE_CHOICES = ("admin", "supervisor", "refueler", "viewer")


db = SQLAlchemy(app)


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
    date = db.Column(db.Date, nullable=False)
    origin = db.Column(db.String(32), nullable=True)
    destination = db.Column(db.String(32), nullable=True)
    eta_local = db.Column(db.Time, nullable=True)
    etd_local = db.Column(db.Time, nullable=True)
    tail_number = db.Column(db.String(32), nullable=True)
    truck_assignment = db.Column(db.String(64), nullable=True)
    status = db.Column(db.String(32), nullable=True)
    notes = db.Column(db.Text, nullable=True)


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
    user = get_current_user()
    role = user.role if user else get_current_role() or "viewer"
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


@app.context_processor
def inject_role():
    return {
        "get_current_role": get_current_role,
        "current_user": get_current_user(),
        "current_role": get_current_role(),
        "display_name": session.get("display_name"),
    }

BASE_DIR = os.path.dirname(__file__)
app.config["UPLOAD_FOLDER"] = os.path.join(BASE_DIR, "uploads")
app.config["OUTPUTS_DIR"]  = os.path.join(BASE_DIR, "outputs")
os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
os.makedirs(app.config["OUTPUTS_DIR"], exist_ok=True)

orchestrator = BuildOrchestrator(outputs_dir=app.config["OUTPUTS_DIR"])
fixer = FixService()
knower = KnowledgeService(outputs_dir=app.config["OUTPUTS_DIR"])
import_service = ImportService(db=db, ImportBatch=ImportBatch, ImportRow=ImportRow)

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
@require_role("refueler", "supervisor")
def roster_page():
    """
    Roster page showing personnel assignments.
    Now backed by the RosterEntry table instead of in-memory data.
    """
    roster_entries = (
        RosterEntry.query.order_by(RosterEntry.date.asc(), RosterEntry.shift_start.asc())
        .all()
    )
    return render_template("roster.html", roster=roster_entries)


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
@require_role("refueler", "supervisor")
def schedule_page():
    """
    Flight schedule page, now backed by the Flight table.
    """
    flights = Flight.query.order_by(Flight.date.asc(), Flight.eta_local.asc()).all()
    return render_template("schedule.html", flights=flights)


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
    return render_template("admin_import.html", batches=batches)


@app.route("/admin/import/upload", methods=["POST"])
@require_role("admin", "supervisor")
def admin_import_upload():
    import_type = request.form.get("import_type", "flights")
    if import_type not in ("flights", "roster"):
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
                f = Flight(
                    flight_number=data.get("flight_number", "").strip(),
                    date=_parse_date(data.get("date")),
                    origin=data.get("origin"),
                    destination=data.get("destination"),
                    eta_local=_parse_time(data.get("eta_local")),
                    etd_local=_parse_time(data.get("etd_local")),
                    tail_number=data.get("tail_number"),
                    truck_assignment=data.get("truck_assignment"),
                    status=data.get("status"),
                    notes=data.get("notes"),
                )
                db.session.add(f)
            else:
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
def maintenance_page():
    """
    Truck maintenance page showing upcoming service dates.
    One sentence explanation: renders maintenance.html with truck maintenance data.
    """
    return render_template("maintenance.html", trucks=TRUCKS)


@app.route("/machine-room")
@requires_supervisor
def machine_room():
    """
    Supervisor-only view with database and system overview.
    Shows table counts and a small sample of records.
    """

    uri = app.config["SQLALCHEMY_DATABASE_URI"]
    db_type = detect_db_type(uri)

    employee_count = Employee.query.count()
    flight_count = Flight.query.count()

    recent_employees = Employee.query.order_by(Employee.id.desc()).limit(5).all()
    recent_flights = (
        Flight.query.order_by(Flight.date.desc(), Flight.eta_local.desc())
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
        recent_employees=recent_employees,
        recent_flights=recent_flights,
        recent_audit=recent_audit,
    )


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


