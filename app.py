import os
from datetime import datetime
from zipfile import ZipFile, ZIP_DEFLATED

from flask import (
    Flask,
    flash,
    jsonify,
    redirect,
    render_template,
    request,
    send_from_directory,
    url_for,
)
from flask_sqlalchemy import SQLAlchemy

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
app.config["SQLALCHEMY_DATABASE_URI"] = os.getenv(
    "DATABASE_URL", "sqlite:///cc_office.db"
)
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

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

@app.route("/build", methods=["GET", "POST"])
def build():
    return render_template("build.html", job=None, steps=[])

@app.route("/fix", methods=["GET", "POST"])
def fix():
    return render_template("fix.html", fix_report=None)

@app.route("/know", methods=["GET", "POST"])
def know():
    return render_template("know.html", answer=None)

# ----- Pages: Office Manager -----
@app.route("/roster")
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
            db.session.commit()
            flash("Employee created.", "success")
            return redirect(url_for("roster_page"))

    return render_template("employee_form.html", employee=None)


@app.route("/employees/<int:employee_id>/edit", methods=["GET", "POST"])
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
            emp.name = name
            emp.role = role
            emp.shift = shift
            emp.base = base or None
            emp.active = active
            db.session.commit()
            flash("Employee updated.", "success")
            return redirect(url_for("roster_page"))

    return render_template("employee_form.html", employee=emp)


@app.route("/employees/<int:employee_id>/delete", methods=["POST"])
def employee_delete(employee_id):
    """
    Soft delete or hard delete an employee.
    For now: hard delete.
    """
    emp = Employee.query.get_or_404(employee_id)
    db.session.delete(emp)
    db.session.commit()
    flash("Employee deleted.", "success")
    return redirect(url_for("roster_page"))


@app.route("/schedule")
def schedule_page():
    """
    Flight schedule page, now backed by the Flight table.
    """
    flights = Flight.query.order_by(Flight.eta).all()
    return render_template("schedule.html", flights=flights)


@app.route("/flights/new", methods=["GET", "POST"])
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
                db.session.commit()
                flash("Flight created.", "success")
                return redirect(url_for("schedule_page"))

    return render_template("flight_form.html", flight=None)


@app.route("/flights/<int:flight_id>/edit", methods=["GET", "POST"])
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
                f.flight_number = flight_number
                f.airline = airline
                f.eta = eta
                f.bay = bay or None
                f.fuel_tonnes = float(fuel_tonnes_str) if fuel_tonnes_str else None
                f.status = status
                db.session.commit()
                flash("Flight updated.", "success")
                return redirect(url_for("schedule_page"))

    eta_value = f.eta.strftime("%Y-%m-%dT%H:%M")
    return render_template("flight_form.html", flight=f, eta_value=eta_value)


@app.route("/flights/<int:flight_id>/delete", methods=["POST"])
def flight_delete(flight_id):
    """
    Delete a flight entry.
    """
    f = Flight.query.get_or_404(flight_id)
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


