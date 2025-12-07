from __future__ import annotations

import json
from datetime import datetime, time
from pathlib import Path
from typing import Any, Dict, List

from flask import current_app

from app import Employee, RosterTemplateDay, RosterTemplateWeek, Staff, db, ensure_roster_schema


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


def _load_seed_json() -> Dict[str, Any]:
    base_dir = Path(current_app.root_path)
    seed_path = base_dir / "TheBrain" / "seed" / "staff_and_roster_dec24.json"
    if not seed_path.exists():
        raise FileNotFoundError(f"Roster seed file not found: {seed_path}")
    with seed_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def load_dec24_roster_seed() -> Dict[str, Any]:
    ensure_roster_schema()
    data = _load_seed_json()

    staff_seed: List[Dict[str, Any]] = data.get("staff", [])
    tpl_seed: Dict[str, Any] = data.get("weekly_template") or {}

    created_staff = updated_staff = 0
    created_emps = updated_emps = 0

    # Staff + Employee mirror
    for item in staff_seed:
        code = (item.get("code") or "").strip()
        if not code:
            continue
        name = (item.get("name") or "").strip() or code
        emp_type = (item.get("employment_type") or "").strip() or "FT"
        active = bool(item.get("active", True))

        staff = Staff.query.filter_by(code=code).first()
        if not staff:
            staff = Staff(code=code)
            db.session.add(staff)
            created_staff += 1
        else:
            updated_staff += 1

        staff.name = name
        staff.employment_type = emp_type
        staff.active = active

        emp = Employee.query.filter_by(code=code).first()
        if not emp:
            emp = Employee(code=code)
            db.session.add(emp)
            created_emps += 1
        else:
            updated_emps += 1

        emp.name = name
        emp.role = "refueler"
        emp.employment_type = emp_type
        emp.base = "SYD"
        emp.shift = None
        emp.is_active = active

    db.session.flush()

    # Weekly template
    name = tpl_seed.get("name") or "SYD_JQ_default_week_dec24"
    desc = tpl_seed.get("description") or ""
    is_active = bool(tpl_seed.get("is_active", True))

    tpl = RosterTemplateWeek.query.filter_by(name=name).first()
    if not tpl:
        tpl = RosterTemplateWeek(name=name, description=desc, is_active=is_active)
        db.session.add(tpl)
    else:
        tpl.description = desc
        tpl.is_active = is_active

    db.session.flush()
    RosterTemplateDay.query.filter_by(template_id=tpl.id).delete()

    lines_created = 0
    days = tpl_seed.get("days") or {}
    for weekday_str, entries in days.items():
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
        "employees_created": created_emps,
        "employees_updated": updated_emps,
        "template_lines_created": lines_created,
    }
