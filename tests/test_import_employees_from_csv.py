from pathlib import Path

import pytest

from app import Employee, Staff, app, db
from scripts.import_employees_from_csv import import_employees_from_csv


@pytest.fixture()
def app_ctx():
    with app.app_context():
        db.create_all()
        yield
        db.session.remove()
        db.drop_all()


def write_csv(tmp_path: Path, content: str) -> Path:
    csv_path = tmp_path / "employees.csv"
    csv_path.write_text(content, encoding="utf-8")
    return csv_path


def test_import_creates_and_updates_employee_and_staff(tmp_path: Path, app_ctx):
    csv_content = """name,code,role,shift,base,employment_type,weekly_hours_target,active,notes
Mary Green,MG,operator,Day,SYD,FT,38,yes,Lead operator
Mary Green,MG,supervisor,Evening,SYD,FT,40,,Promoted
"""

    csv_file = write_csv(tmp_path, csv_content)

    summary = import_employees_from_csv(str(csv_file))

    assert summary == {"processed": 2, "created": 1, "updated": 1, "skipped": 0}

    employee = Employee.query.filter_by(code="MG").one()
    assert employee.name == "Mary Green"
    assert employee.role == "supervisor"
    assert employee.shift == "Evening"
    assert employee.base == "SYD"
    assert employee.employment_type == "FT"
    assert employee.weekly_hours_target == 40
    assert employee.notes == "Promoted"
    assert employee.active is True

    staff = Staff.query.filter_by(code="MG").one()
    assert staff.name == "Mary Green"
    assert staff.employment_type == "FT"
    assert staff.weekly_hours_target == 40
    assert staff.active is True


def test_rows_without_identifiers_are_skipped(tmp_path: Path, app_ctx):
    csv_content = """name,code,role,employment_type
 , ,,
Code Only,CO,operator,FT
"""

    csv_file = write_csv(tmp_path, csv_content)

    summary = import_employees_from_csv(str(csv_file))

    assert summary == {"processed": 2, "created": 1, "updated": 0, "skipped": 1}

    employee = Employee.query.filter_by(code="CO").one()
    assert employee.name == "Code Only"
    assert employee.role == "operator"
    assert employee.employment_type == "FT"
    assert employee.active is True


def test_active_flag_respected(tmp_path: Path, app_ctx):
    csv_content = """name,code,active,employment_type,weekly_hours_target
Inactive User,IU,no,PT,20
"""

    csv_file = write_csv(tmp_path, csv_content)

    summary = import_employees_from_csv(str(csv_file))

    assert summary == {"processed": 1, "created": 1, "updated": 0, "skipped": 0}

    employee = Employee.query.filter_by(code="IU").one()
    assert employee.active is False

    staff = Staff.query.filter_by(code="IU").one()
    assert staff.active is False
    assert staff.employment_type == "PT"
    assert staff.weekly_hours_target == 20
