from __future__ import annotations

from datetime import datetime, time
from pathlib import Path
from typing import Any, Dict

from flask import current_app

TEMPLATE_NAME = "SYD_JQ_default_week_dec24"


def _parse_time(value: str | None) -> time | None:
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(value, fmt).time()
        except ValueError:
            continue
    return None


def _seed_path() -> Path:
    root = Path(current_app.root_path)
    return root / "office_seeds" / "dec24_roster_seed.json"


def _load_seed_json() -> Dict[str, Any]:
    path = _seed_path()
    if not path.exists():
        raise FileNotFoundError(f"Roster seed file not found: {path}")
    import json

    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_dec24_office_roster_seed() -> Dict[str, Any]:
    """Seed staff + weekly roster template for DEC24 into the Office DB.

    Idempotent: re-running updates staff/employees and replaces template days.
    """

    from app import (
        Employee,
        RosterTemplateDay,
        RosterTemplateWeek,
        Staff,
        db,
        ensure_employee_table,
        ensure_roster_schema,
    )

    ensure_roster_schema()
    ensure_employee_table()

    data = _load_seed_json()
    airline = (data.get("airline") or "JQ").strip() or "JQ"

    shift_map: dict[str, tuple[time | None, time | None]] = {}
    for sh in data.get("shifts", []):
        code = (sh.get("code") or "").strip()
        if not code:
            continue
        shift_map[code] = (_parse_time(sh.get("start")), _parse_time(sh.get("end")))

    created_staff = updated_staff = created_emp = updated_emp = 0

    for emp in data.get("employees", []):
        code = (emp.get("code") or "").strip()
        if not code:
            continue
        name = (emp.get("name") or code).strip()

        staff = Staff.query.filter_by(code=code).first()
        if not staff:
            staff = Staff(code=code)
            db.session.add(staff)
            created_staff += 1
        else:
            updated_staff += 1
        staff.name = name
        staff.employment_type = staff.employment_type or "FT"
        staff.active = True

        employee = Employee.query.filter_by(code=code).first()
        if not employee:
            employee = Employee(code=code)
            db.session.add(employee)
            created_emp += 1
        else:
            updated_emp += 1
        employee.name = name
        employee.role = employee.role or "refueller"
        employee.employment_type = employee.employment_type or staff.employment_type
        employee.base = employee.base or "SYD"
        employee.shift = employee.shift or ""
        employee.is_active = True

    db.session.flush()

    template = RosterTemplateWeek.query.filter_by(name=TEMPLATE_NAME).first()
    created_tpl = False
    if not template:
        template = RosterTemplateWeek(name=TEMPLATE_NAME)
        db.session.add(template)
        created_tpl = True
    template.description = data.get("version") or f"{airline} DEC24 roster"
    template.is_active = True

    db.session.flush()

    RosterTemplateDay.query.filter_by(template_id=template.id).delete()

    lines_created = 0
    for tpl in data.get("templates", []):
        weekday = tpl.get("weekday")
        if weekday is None:
            continue

        for line in tpl.get("lines", []):
            staff_code = (line.get("employee_code") or "").strip()
            if not staff_code:
                continue
            staff = Staff.query.filter_by(code=staff_code).first()
            if not staff:
                continue

            shift_code = (line.get("shift_code") or "").strip()
            start_local, end_local = shift_map.get(shift_code, (None, None))
            if not start_local or not end_local:
                continue

            row = RosterTemplateDay(
                template_id=template.id,
                weekday=weekday,
                staff_id=staff.id,
                start_local=start_local,
                end_local=end_local,
                role="refueller",
            )
            db.session.add(row)
            lines_created += 1

    db.session.commit()

    return {
        "ok": True,
        "template_name": template.name,
        "template_id": template.id,
        "staff_created": created_staff,
        "staff_updated": updated_staff,
        "employees_created": created_emp,
        "employees_updated": updated_emp,
        "templates_created": 1 if created_tpl else 0,
        "template_lines_created": lines_created,
    }
