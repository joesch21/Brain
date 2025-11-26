import os
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

app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY") or os.getenv("FLASK_SECRET_KEY", "dev-secret-key-change-me")
raw_uri = os.getenv("DATABASE_URL", "sqlite:///cc_office.db")
app.config["SUPERVISOR_KEY"] = os.getenv("SUPERVISOR_KEY")
app.config["ADMIN_KEY"] = os.getenv("ADMIN_KEY")

# Normalize old-style postgres scheme for SQLAlchemy
if raw_uri.startswith("postgres://"):
    raw_uri = raw_uri.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = raw_uri
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

SUPPORTED_ROLES = ("admin", "supervisor", "refueler", "viewer", "operator")
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
    flight_number = db.Column(db.String(20), nullable=False)
    airline = db.Column(db.String(80), nullable=False)
    eta = db.Column(db.DateTime, nullable=False)
    bay = db.Column(db.String(20), nullable=True)
    fuel_tonnes = db.Column(db.Float, nullable=True)
    status = db.Column(db.String(40), default="Scheduled")


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
                flash("Please log in to access this page.", "info")
                return redirect(url_for("login", next=request.path))

            if role == "admin" or (user and user.is_admin):
                return view_func(*args, **kwargs)

            if roles:
                if role not in roles and not (user and user.role in roles):
                    flash("You do not have permission to access this page.", "error")
                    return redirect(url_for("home"))

            return view_func(*args, **kwargs)

        return wrapper

    return decorator


def requires_supervisor(f):
    return require_role("supervisor")(f)


def log_audit(entity_type, entity_id, action, description=None):
    """
    Record a simple audit event in the AuditLog table.
    """
    user = get_current_user()
    role = user.role if user else get_current_role() or "operator"
    entry = AuditLog(
        entity_type=entity_type,
        entity_id=entity_id,
        action=action,
        description=description,
        actor_role=role,
        actor_name=user.username if user else None,
    )
    db.session.add(entry)


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

# ----- Pages -----
@app.route("/")
def home():
    return render_template("home.html", job=None)


@app.route("/login", methods=["GET", "POST"])
def login():
    """
    Simple login: username + password.
    """
    next_url = request.args.get("next") or url_for("home")

    if get_current_role():
        flash("You are already logged in.", "info")
        return redirect(next_url)

    if request.method == "POST":
        next_url = request.form.get("next") or next_url

        admin_key_input = (request.form.get("admin_key") or "").strip()
        supervisor_key_input = (request.form.get("supervisor_key") or "").strip()
        configured_admin_key = app.config.get("ADMIN_KEY")
        configured_key = app.config.get("SUPERVISOR_KEY")

        if admin_key_input:
            if configured_admin_key and admin_key_input == configured_admin_key:
                session["user_id"] = None
                session["role"] = "admin"
                session["display_name"] = "Admin (key)"
                flash("Admin access granted.", "success")
                return redirect(next_url)
            flash("Invalid admin key.", "error")
            return render_template("login.html", next_url=next_url)

        if supervisor_key_input:
            if configured_key and supervisor_key_input == configured_key:
                session["user_id"] = None
                session["role"] = "supervisor"
                session["display_name"] = "Supervisor (key)"
                flash("Supervisor access granted.", "success")
                return redirect(next_url)
            flash("Invalid supervisor key.", "error")
            return render_template("login.html", next_url=next_url)

        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""

        if username and password:
            user = User.query.filter_by(username=username).first()
            if not user or not user.check_password(password):
                flash("Invalid username or password.", "error")
                return render_template("login.html", next_url=next_url)

            session["user_id"] = user.id
            session["role"] = user.role
            session["display_name"] = user.username
            flash(f"Logged in as {user.username} ({user.role}).", "success")
            return redirect(next_url)

        flash("Please enter a valid admin key, supervisor key or username/password.", "error")
        return render_template("login.html", next_url=next_url)

    return render_template("login.html", next_url=next_url)


@app.route("/logout")
def logout():
    """
    Clear login session.
    """
    session.clear()
    flash("Logged out.", "success")
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
            flash("Username and password are required.", "error")
            return render_template("admin_users_form.html", mode="new")

        if role not in ROLE_CHOICES:
            flash("Invalid role.", "error")
            return render_template("admin_users_form.html", mode="new")

        existing = User.query.filter_by(username=username).first()
        if existing:
            flash("Username already exists.", "error")
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
            flash("Invalid role.", "error")
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
@require_role("operator", "supervisor")
def roster_page():
    """
    Roster page showing personnel assignments.
    Now backed by the Employee table instead of in-memory data.
    """
    employees = (
        Employee.query.filter_by(active=True)
        .order_by(Employee.shift, Employee.name)
        .all()
    )
    return render_template("roster.html", roster=employees)


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
@require_role("operator", "supervisor")
def schedule_page():
    """
    Flight schedule page, now backed by the Flight table.
    """
    flights = Flight.query.order_by(Flight.eta).all()
    return render_template("schedule.html", flights=flights)


@app.route("/flights/new", methods=["GET", "POST"])
@requires_supervisor
def flight_create():
    """
    Create a new scheduled flight.
    """
    if request.method == "POST":
        flight_number = request.form.get("flight_number", "").strip()
        airline = request.form.get("airline", "").strip()
        eta_str = request.form.get("eta", "").strip()
        bay = request.form.get("bay", "").strip()
        fuel_tonnes_str = request.form.get("fuel_tonnes", "").strip()
        status = request.form.get("status", "").strip() or "Scheduled"

        if not flight_number or not airline or not eta_str:
            flash("Flight number, airline and ETA are required.", "error")
        else:
            try:
                eta = datetime.fromisoformat(eta_str)
            except ValueError:
                flash("Invalid ETA format.", "error")
            else:
                fuel_tonnes = float(fuel_tonnes_str) if fuel_tonnes_str else None
                f = Flight(
                    flight_number=flight_number,
                    airline=airline,
                    eta=eta,
                    bay=bay or None,
                    fuel_tonnes=fuel_tonnes,
                    status=status,
                )
                db.session.add(f)
                db.session.flush()
                log_audit(
                    entity_type="Flight",
                    entity_id=f.id,
                    action="create",
                    description=f"Created flight {f.flight_number} {f.airline} eta={f.eta} bay={f.bay} fuel={f.fuel_tonnes}",
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
        airline = request.form.get("airline", "").strip()
        eta_str = request.form.get("eta", "").strip()
        bay = request.form.get("bay", "").strip()
        fuel_tonnes_str = request.form.get("fuel_tonnes", "").strip()
        status = request.form.get("status", "").strip() or "Scheduled"

        if not flight_number or not airline or not eta_str:
            flash("Flight number, airline and ETA are required.", "error")
        else:
            try:
                eta = datetime.fromisoformat(eta_str)
            except ValueError:
                flash("Invalid ETA format.", "error")
            else:
                before = f"{f.flight_number} {f.airline} eta={f.eta} bay={f.bay} fuel={f.fuel_tonnes} status={f.status}"
                f.flight_number = flight_number
                f.airline = airline
                f.eta = eta
                f.bay = bay or None
                f.fuel_tonnes = float(fuel_tonnes_str) if fuel_tonnes_str else None
                f.status = status
                after = f"{f.flight_number} {f.airline} eta={f.eta} bay={f.bay} fuel={f.fuel_tonnes} status={f.status}"
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

    eta_value = f.eta.strftime("%Y-%m-%dT%H:%M")
    return render_template("flight_form.html", flight=f, eta_value=eta_value)


@app.route("/flights/<int:flight_id>/delete", methods=["POST"])
@requires_supervisor
def flight_delete(flight_id):
    """
    Delete a flight entry.
    """
    f = Flight.query.get_or_404(flight_id)
    summary = f"{f.flight_number} {f.airline} eta={f.eta} bay={f.bay} fuel={f.fuel_tonnes} status={f.status}"
    log_audit(
        entity_type="Flight",
        entity_id=f.id,
        action="delete",
        description=f"Deleted flight {flight_id}: {summary}",
    )
    db.session.delete(f)
    db.session.commit()
    flash("Flight deleted.", "success")
    return redirect(url_for("schedule_page"))


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
    if uri.startswith("postgres"):
        db_type = "PostgreSQL"
    elif uri.startswith("sqlite"):
        db_type = "SQLite"
    else:
        db_type = "Unknown"

    employee_count = Employee.query.count()
    flight_count = Flight.query.count()

    recent_employees = Employee.query.order_by(Employee.id.desc()).limit(5).all()
    recent_flights = Flight.query.order_by(Flight.eta.desc()).limit(5).all()
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


