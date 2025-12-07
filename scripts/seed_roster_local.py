from __future__ import annotations

import json
from datetime import time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, List

from flask import current_app

if TYPE_CHECKING:  # pragma: no cover
    from app import (
        Employee,
        RosterTemplateDay,
        RosterTemplateWeek,
        Staff,
        db,
        ensure_roster_schema,
    )


def _parse_time(value: str | None) -> time | None:
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    from datetime import datetime

    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            return datetime.strptime(value, fmt).time()
        except ValueError:
            continue
    return None


def _load_seed_json() -> Dict[str, Any]:
    """
    Load staff_and_roster_v1.json from the TheBrain/seed directory.
    """

    base_dir = Path(current_app.root_path)
    seed_path = base_dir / "TheBrain" / "seed" / "staff_and_roster_v1.json"
    if not seed_path.exists():
        raise FileNotFoundError(f"Seed file not found: {seed_path}")
    with seed_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def seed_staff_and_roster_from_file() -> Dict[str, Any]:
    """
    Upsert Staff + Employee rows and a weekly roster template from the seed JSON.

    Idempotent: re-running will update existing rows instead of duplicating them.
    """

    from app import (
        Employee,
        RosterTemplateDay,
        RosterTemplateWeek,
        Staff,
        db,
        ensure_roster_schema,
    )

    ensure_roster_schema()
    data = _load_seed_json()

    staff_seed: List[Dict[str, Any]] = data.get("staff", [])
    tpl_seed: Dict[str, Any] = data.get("weekly_template") or {}

    created_staff = 0
    updated_staff = 0
    created_employees = 0
    updated_employees = 0

    for item in staff_seed:
        code = (item.get("code") or "").strip()
        name = (item.get("name") or "").strip() or code
        employment_type = (item.get("employment_type") or "").strip() or "FT"
        skills = item.get("skills") or []

        if not code:
            continue

        staff = Staff.query.filter_by(code=code).first()
        if not staff:
            staff = Staff(code=code, name=name, employment_type=employment_type, active=True)
            db.session.add(staff)
            created_staff += 1
        else:
            updated_staff += 1

        staff.name = name
        staff.employment_type = employment_type
        staff.active = True
        staff.skills = skills

        emp = Employee.query.filter_by(code=code).first()
        if not emp:
            emp = Employee(code=code)
            db.session.add(emp)
            created_employees += 1
        else:
            updated_employees += 1

        emp.name = name
        emp.role = "refueler"
        emp.employment_type = employment_type
        emp.shift = None
        emp.base = "SYD"
        emp.is_active = True

    db.session.flush()

    name = tpl_seed.get("name") or "SYD_JQ_default_week_v1"
    description = tpl_seed.get("description") or ""
    is_active = bool(tpl_seed.get("is_active", True))

    template = RosterTemplateWeek.query.filter_by(name=name).first()
    if not template:
        template = RosterTemplateWeek(name=name, description=description, is_active=is_active)
        db.session.add(template)
    else:
        template.description = description
        template.is_active = is_active

    db.session.flush()

    RosterTemplateDay.query.filter_by(template_id=template.id).delete()

    lines_created = 0
    days_map: Dict[str, List[Dict[str, Any]]] = tpl_seed.get("days") or {}
    for weekday_str, entries in days_map.items():
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

            day_row = RosterTemplateDay(
                template_id=template.id,
                weekday=weekday,
                staff_id=staff.id,
                start_local=start_local,
                end_local=end_local,
                role=role,
            )
            db.session.add(day_row)
            lines_created += 1

    db.session.commit()

    return {
        "ok": True,
        "template_name": template.name,
        "template_id": template.id,
        "staff_created": created_staff,
        "staff_updated": updated_staff,
        "employees_created": created_employees,
        "employees_updated": updated_employees,
        "template_lines_created": lines_created,
    }
