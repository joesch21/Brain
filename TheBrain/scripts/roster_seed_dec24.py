from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from typing import TYPE_CHECKING

from flask import current_app

if TYPE_CHECKING:  # pragma: no cover
    from app import (
        Employee,
        RosterTemplateDay,
        RosterTemplateWeek,
        Staff,
        db,
        ensure_employee_table,
        ensure_roster_schema,
    )


def _parse_time(value: str | None):
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
    return root / "TheBrain" / "seed" / "staff_and_roster_dec24.json"


def _load_seed_json() -> Dict[str, Any]:
    path = _seed_path()
    if not path.exists():
        raise FileNotFoundError(f"Roster seed file not found: {path}")
    import json

    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def load_dec24_roster_seed() -> Dict[str, Any]:
    """
    Load staff + weekly roster template from seed JSON into the Office DB.

    Idempotent: re-running updates staff and replaces template days.
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

    staff_seed: List[Dict[str, Any]] = data.get("staff") or []
    tpl_seed: Dict[str, Any] = data.get("weekly_template") or {}

    created_staff = updated_staff = created_emp = updated_emp = 0

    for item in staff_seed:
        code = (item.get("code") or "").strip()
        if not code:
            continue
        name = (item.get("name") or code).strip()
        etype = (item.get("employment_type") or "FT").strip()
        active = bool(item.get("active", True))

        staff = Staff.query.filter_by(code=code).first()
        if not staff:
            staff = Staff(code=code)
            db.session.add(staff)
            created_staff += 1
        else:
            updated_staff += 1
        staff.name = name
        staff.employment_type = etype
        staff.active = active

        emp = Employee.query.filter_by(code=code).first()
        if not emp:
            emp = Employee(code=code)
            db.session.add(emp)
            created_emp += 1
        else:
            updated_emp += 1
        emp.name = name
        emp.role = "refueller"
        emp.employment_type = etype
        emp.base = "SYD"
        emp.shift = ""
        emp.is_active = active

    db.session.flush()

    tpl_name = tpl_seed.get("name") or "SYD_JQ_default_week_dec24"
    tpl_desc = tpl_seed.get("description") or ""
    tpl_active = bool(tpl_seed.get("is_active", True))

    tpl = RosterTemplateWeek.query.filter_by(name=tpl_name).first()
    created_tpl = False
    if not tpl:
        tpl = RosterTemplateWeek(name=tpl_name)
        db.session.add(tpl)
        created_tpl = True
    tpl.description = tpl_desc
    tpl.is_active = tpl_active

    db.session.flush()

    RosterTemplateDay.query.filter_by(template_id=tpl.id).delete()

    lines_created = 0
    for weekday_str, entries in (tpl_seed.get("days") or {}).items():
        try:
            weekday = int(weekday_str)
        except ValueError:
            continue

        for entry in entries:
            staff_code = (entry.get("staff_code") or "").strip()
            if not staff_code:
                continue
            staff = Staff.query.filter_by(code=staff_code).first()
            if not staff:
                continue

            start_local = _parse_time(entry.get("start"))
            end_local = _parse_time(entry.get("end"))
            role = (entry.get("role") or "refueller").strip() or "refueller"

            row = RosterTemplateDay(
                template_id=tpl.id,
                weekday=weekday,
                staff_id=staff.id,
                start_local=start_local,
                end_local=end_local,
                role=role,
            )
            db.session.add(row)
            lines_created += 1

    db.session.commit()

    return {
        "ok": True,
        "template_name": tpl.name,
        "template_id": tpl.id,
        "staff_created": created_staff,
        "staff_updated": updated_staff,
        "employees_created": created_emp,
        "employees_updated": updated_emp,
        "templates_created": 1 if created_tpl else 0,
        "template_lines_created": lines_created,
    }
