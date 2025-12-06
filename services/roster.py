from __future__ import annotations

from datetime import date, time

from sqlalchemy.orm import joinedload

from app import RosterTemplateDay, RosterTemplateWeek, Staff

DEFAULT_TEMPLATE_NAME = "SYD_JQ_default_week_v1"


def _serialize_time(value: time | None) -> str | None:
    return value.strftime("%H:%M") if value else None


def _resolve_template(template_name: str | None) -> RosterTemplateWeek | None:
    query = RosterTemplateWeek.query
    template = None

    if template_name:
        template = query.filter_by(name=template_name, is_active=True).first()
        if template:
            return template

        template = query.filter_by(name=template_name).first()
        if template:
            return template

    template = query.filter_by(is_active=True).first()
    return template


def get_daily_roster(
    target_date: date, template_name: str = DEFAULT_TEMPLATE_NAME
) -> dict:
    """Return a JSON-ready roster for the provided date.

    Raises ``ValueError`` when the date is missing/invalid or no template is found.
    """

    if not target_date:
        raise ValueError("date is required")

    weekday = target_date.weekday()
    template = _resolve_template(template_name)
    if not template:
        raise ValueError("No active roster template found.")

    day_rows: list[RosterTemplateDay] = (
        RosterTemplateDay.query.options(joinedload(RosterTemplateDay.staff))
        .filter_by(template_id=template.id, weekday=weekday)
        .all()
    )

    shifts = []
    for day in day_rows:
        if not day.staff:
            continue
        shifts.append(
            {
                "staff_id": day.staff.id,
                "staff_code": day.staff.code,
                "staff_name": day.staff.name,
                "employment_type": day.staff.employment_type,
                "start_local": _serialize_time(day.start_local),
                "end_local": _serialize_time(day.end_local),
                "role": day.role,
            }
        )

    return {"date": target_date.isoformat(), "template_id": template.id, "shifts": shifts}
