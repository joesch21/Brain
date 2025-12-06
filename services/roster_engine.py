"""Roster generation and employee-to-flight assignment helpers."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Iterable

from sqlalchemy import and_

from app import (
    Employee,
    Flight,
    RosterEntry,
    SYD_TZ,
    WeeklyRosterTemplate,
    db,
)

ASSIGNABLE_ROLES = {"refueler", "refueller", "fueler", "supervisor"}


def _normalize_dates(start_date: date, end_date: date) -> tuple[date, date]:
    if start_date <= end_date:
        return start_date, end_date
    return end_date, start_date


def _covers_time(entry: RosterEntry, local_time) -> bool:
    """Return True if the roster entry covers the provided time."""

    if local_time is None:
        return False
    start = entry.shift_start
    end = entry.shift_end
    if start and end:
        return start <= local_time <= end
    if start and not end:
        return local_time >= start
    if end and not start:
        return local_time <= end
    return True


def _flight_time_local(flight: Flight):
    from app import _time_from_value

    return _time_from_value(flight.etd_local or flight.eta_local) or flight.time_local


def generate_roster_for_date_range(start_date: date, end_date: date) -> dict:
    """Populate dated roster entries from the weekly template.

    Idempotent: matching entries (date + employee + role + shift window) are
    updated in place instead of duplicated.
    """

    start_date, end_date = _normalize_dates(start_date, end_date)
    created = 0
    updated = 0
    days = 0

    template_map: dict[int, list[WeeklyRosterTemplate]] = defaultdict(list)
    templates: Iterable[WeeklyRosterTemplate] = WeeklyRosterTemplate.query.all()
    for template in templates:
        template_map[template.weekday].append(template)

    current = start_date
    while current <= end_date:
        weekday = current.weekday()
        for template in template_map.get(weekday, []):
            employee = template.employee
            if not employee:
                continue

            existing = RosterEntry.query.filter(
                and_(
                    RosterEntry.date == current,
                    RosterEntry.employee_name == employee.name,
                    RosterEntry.role == template.role,
                    RosterEntry.shift_start == template.shift_start,
                    RosterEntry.shift_end == template.shift_end,
                )
            ).first()

            if existing:
                changed = False
                if existing.truck != template.truck:
                    existing.truck = template.truck
                    changed = True
                if existing.notes != template.notes:
                    existing.notes = template.notes
                    changed = True
                if changed:
                    updated += 1
                continue

            entry = RosterEntry(
                date=current,
                employee_name=employee.name,
                role=template.role,
                shift_start=template.shift_start,
                shift_end=template.shift_end,
                truck=template.truck,
                notes=template.notes,
            )
            db.session.add(entry)
            created += 1
        days += 1
        current += timedelta(days=1)

    db.session.commit()
    return {"days": days, "entries_created": created, "entries_updated": updated}


def auto_assign_employees_for_date(target_date: date, airline: str = "JQ") -> dict:
    """Assign rostered employees to flights for the given airline/day."""

    airline_code = (airline or "").upper()

    flights_query = Flight.query.filter(Flight.date == target_date)
    flights_query = flights_query.filter(
        db.or_(
            Flight.flight_number.ilike(f"{airline_code}%"),
            Flight.airline == airline_code,
            Flight.operator_code == airline_code,
        )
    )
    default_time = datetime.combine(target_date, time.min, tzinfo=SYD_TZ).timetz()
    flights = list(
        sorted(
            flights_query.all(),
            key=lambda f: _flight_time_local(f) or default_time,
        )
    )

    roster_entries: list[RosterEntry] = (
        RosterEntry.query.filter(RosterEntry.date == target_date)
        .order_by(RosterEntry.shift_start.asc())
        .all()
    )

    assignment_counts: dict[str, int] = defaultdict(int)
    assigned = 0
    unassigned = 0

    for flight in flights:
        # Clear existing assignment so reruns overwrite cleanly.
        flight.assigned_employee_id = None
        flight.assigned_employee_name = None
        flight.assigned_truck = None

    db.session.flush()

    for flight in flights:
        local_time = _flight_time_local(flight)
        eligible = [
            entry
            for entry in roster_entries
            if entry.employee_name
            and entry.role
            and entry.role.strip().lower() in ASSIGNABLE_ROLES
            and _covers_time(entry, local_time)
        ]

        if not eligible:
            unassigned += 1
            continue

        eligible.sort(
            key=lambda entry: (assignment_counts[entry.employee_name], entry.employee_name)
        )
        chosen = eligible[0]
        flight.assigned_employee_name = chosen.employee_name
        flight.assigned_truck = chosen.truck
        employee = Employee.query.filter_by(name=chosen.employee_name).first()
        if employee:
            flight.assigned_employee_id = employee.id
            employee_key = employee.name
        else:
            employee_key = chosen.employee_name
        assignment_counts[employee_key] += 1
        assigned += 1

    db.session.commit()

    return {
        "date": target_date.isoformat(),
        "airline": airline_code,
        "total_flights": len(flights),
        "assigned": assigned,
        "unassigned": unassigned,
    }
