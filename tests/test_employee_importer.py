from pathlib import Path

import pytest

from app import Employee, app, db, ensure_employee_table
from scripts.employee_importer import import_employees_from_csv


@pytest.fixture()
def app_ctx():
    with app.app_context():
        db.create_all()
        ensure_employee_table()
        yield
        db.session.remove()
        db.drop_all()


def write_csv(tmp_path: Path, content: str) -> Path:
    csv_path = tmp_path / "employees.csv"
    csv_path.write_text(content, encoding="utf-8")
    return csv_path


def test_import_creates_and_updates_and_skips(tmp_path, app_ctx):
    csv_content = """code,name,role,employment_type,weekly_hours_target,notes
FT1,Alice Brown,refueler,FT,38,
FT1,Alicia Brown,refueler,FT,38,Updated name
PT2,Bob Smith,refueler,PT,twenty,Notes
"""

    csv_file = write_csv(tmp_path, csv_content)

    summary = import_employees_from_csv(csv_file)

    assert summary == {"processed": 3, "created": 1, "updated": 1, "skipped": 1}

    employee = Employee.query.filter_by(code="FT1").one()
    assert employee.name == "Alicia Brown"
    assert employee.employment_type == "FT"
    assert employee.weekly_hours_target == 38
    assert employee.notes == "Updated name"
    assert employee.is_active is True


def test_blank_rows_are_skipped(tmp_path, app_ctx):
    csv_content = """code,name,role
 , ,
FT6,,supervisor
"""

    csv_file = write_csv(tmp_path, csv_content)

    summary = import_employees_from_csv(csv_file)

    assert summary == {"processed": 1, "created": 1, "updated": 0, "skipped": 0}

    employee = Employee.query.filter_by(code="FT6").one()
    assert employee.name is None
    assert employee.role == "supervisor"
