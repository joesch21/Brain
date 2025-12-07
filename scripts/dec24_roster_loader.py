from __future__ import annotations

import json
from datetime import datetime, time
from pathlib import Path
from typing import TYPE_CHECKING, Any, Dict, Iterable

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


SHIFT_FMTS = ("%H:%M", "%H:%M:%S")


def _parse_time(value: str | None) -> time | None:
    if not value:
        return None

    value = value.strip()
    if not value:
        return None

    for fmt in SHIFT_FMTS:
        try:
            return datetime.strptime(value, fmt).time()
        except ValueError:
            continue
    return None


def _normalize_employment_type(raw: str | None, staff_code: str) -> str:
    if raw:
        key = raw.strip().lower()
    else:
        key = ""

    prefix = staff_code.upper()
    if prefix.startswith("FT"):
        return "FT"
    if prefix.startswith("PT"):
        return "PT"
    if prefix.startswith("S"):
        return "SV"
    if prefix in {"TL"}:
        return "TL"
    if prefix in {"MG", "MOM", "TM", "AB", "RG"}:
        return "MG"

    mapping = {
        "full_time": "FT",
        "full-time": "FT",
        "ft": "FT",
        "part_time": "PT",
        "part-time": "PT",
        "pt": "PT",
        "supervisor": "SV",
        "lead": "TL",
        "team_lead": "TL",
        "manager": "MG",
    }
    if key in mapping:
        return mapping[key]

    return (key[:2] or "FT").upper()


def _role_from_staff(staff: Staff | None) -> str:
    if not staff:
        return "refueller"

    supervisor_types = {"SV", "TL", "MG"}
    if (staff.employment_type or "").upper() in supervisor_types:
        return "supervisor"
    return "refueller"


def _shift_map(shift_codes: Iterable[Dict[str, Any]]) -> dict[str, tuple[time | None, time | None]]:
    result: dict[str, tuple[time | None, time | None]] = {}
    for shift in shift_codes or []:
        code = (shift.get("code") or "").strip().upper()
        start = _parse_time(shift.get("start_time"))
        end = _parse_time(shift.get("end_time"))
        if not code:
            continue
        result[code] = (start, end)
    return result


def _weekday_from_name(name: str | None) -> int | None:
    if not name:
        return None
    normalized = name.strip().lower()
    days = {
        "monday": 0,
        "tuesday": 1,
        "wednesday": 2,
        "thursday": 3,
        "friday": 4,
        "saturday": 5,
        "sunday": 6,
    }
    return days.get(normalized)


def load_dec24_roster_seed(path: str | None = None) -> dict:
    """
    Load staff and roster templates from the DEC24 seed JSON into the Office DB.

    Idempotent: re-running will upsert staff, employees, and roster templates.
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

    base_dir = Path(current_app.root_path)
    seed_path = Path(path) if path else base_dir / "TheBrain" / "seed" / "roster_seed_dec24.json"

    if not seed_path.exists():
        raise FileNotFoundError(seed_path)

    ensure_roster_schema()
    ensure_employee_table()

    with seed_path.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    staff_created = 0
    staff_updated = 0
    employees_created = 0
    employees_updated = 0
    templates_imported = 0
    template_days_created = 0

    staff_entries = payload.get("staff") or []
    shift_codes = _shift_map(payload.get("shift_codes") or [])

    # Upsert staff + employees
    for entry in staff_entries:
        code = (entry.get("staff_code") or entry.get("code") or "").strip()
        if not code:
            continue

        display_name = (entry.get("display_name") or entry.get("name") or code).strip()
        employment_type = _normalize_employment_type(entry.get("employment_type"), code)
        active = bool(entry.get("active", True))
        skills = entry.get("skills") or []

        staff = Staff.query.filter_by(code=code).first()
        if not staff:
            staff = Staff(code=code, name=display_name, employment_type=employment_type)
            db.session.add(staff)
            staff_created += 1
        else:
            staff_updated += 1

        staff.name = display_name
        staff.employment_type = employment_type
        staff.active = active
        staff.skills = skills

        emp = Employee.query.filter_by(code=code).first()
        if not emp:
            emp = Employee(code=code)
            db.session.add(emp)
            employees_created += 1
        else:
            employees_updated += 1

        emp.name = display_name
        emp.role = "refueler"
        emp.employment_type = employment_type
        emp.shift = None
        emp.base = "SYD"
        emp.is_active = active

    db.session.flush()

    template_entries = payload.get("templates") or []
    for tpl in template_entries:
        template_code = (tpl.get("template_code") or tpl.get("name") or "").strip()
        if not template_code:
            continue

        weekday = _weekday_from_name(tpl.get("day_of_week"))
        if weekday is None:
            continue

        label = (tpl.get("label") or template_code).strip()

        template = RosterTemplateWeek.query.filter_by(name=template_code).first()
        if not template:
            template = RosterTemplateWeek(name=template_code)
            db.session.add(template)
        template.description = label
        template.is_active = True
        db.session.flush()

        RosterTemplateDay.query.filter_by(template_id=template.id).delete()

        lines = tpl.get("lines") or []
        for line in lines:
            staff_code = (line.get("staff_code") or "").strip()
            if not staff_code:
                continue

            staff = Staff.query.filter_by(code=staff_code).first()
            if not staff:
                continue

            shift_code = (line.get("shift_code") or "").strip().upper()
            start_local = _parse_time(line.get("start_time"))
            end_local = _parse_time(line.get("end_time"))
            if not start_local or not end_local:
                shift_times = shift_codes.get(shift_code)
                if shift_times:
                    start_local = start_local or shift_times[0]
                    end_local = end_local or shift_times[1]

            if not start_local or not end_local:
                continue

            role = (line.get("role") or _role_from_staff(staff)).strip() or "refueller"

            db.session.add(
                RosterTemplateDay(
                    template_id=template.id,
                    weekday=weekday,
                    staff_id=staff.id,
                    start_local=start_local,
                    end_local=end_local,
                    role=role,
                )
            )
            template_days_created += 1

        templates_imported += 1

    db.session.commit()

    return {
        "ok": True,
        "staff_created": staff_created,
        "staff_updated": staff_updated,
        "employees_created": employees_created,
        "employees_updated": employees_updated,
        "templates_imported": templates_imported,
        "template_days_created": template_days_created,
    }

