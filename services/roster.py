from __future__ import annotations

from datetime import date, time

from sqlalchemy.orm import joinedload

from app import RosterTemplateDay, RosterTemplateWeek, Staff

DEFAULT_TEMPLATE_NAME = "SYD_JQ_default_week_dec24"


def _serialize_time(value: time | None) -> str | None:
    return value.strftime("%H:%M") if value else None


def _resolve_template(
    template_name: str | None, weekday: int | None = None
) -> RosterTemplateWeek | None:
    query = RosterTemplateWeek.query
    template = None

    if template_name:
        template = query.filter_by(name=template_name, is_active=True).first()
        if template:
            return template

        template = query.filter_by(name=template_name).first()
        if template:
            return template

    if weekday is not None:
        template = (
            query.join(RosterTemplateDay)
            .filter(RosterTemplateWeek.is_active.is_(True))
            .filter(RosterTemplateDay.weekday == weekday)
            .distinct()
            .first()
        )
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
    template = _resolve_template(template_name, weekday)
    if not template:
        raise ValueError(f"No active roster template found for weekday {weekday}.")

    day_rows: list[RosterTemplateDay] = (
        RosterTemplateDay.query.options(joinedload(RosterTemplateDay.staff))
        .filter_by(template_id=template.id, weekday=weekday)
        .all()
    )

    entries = []
    for day in day_rows:
        if not day.staff:
            continue
        entries.append(
            {
                "staff_id": day.staff.id,
                "staff_code": day.staff.code,
                "staff_name": day.staff.name,
                "employment_type": day.staff.employment_type,
                "start_local": _serialize_time(day.start_local),
                "end_local": _serialize_time(day.end_local),
                "role": day.role,
                "weekday": day.weekday,
            }
        )

    return {
        "date": target_date.isoformat(),
        "template_id": template.id,
        "template_name": template.name,
        "entries": entries,
        "shifts": entries,
    }
