"""Roster generation and employee-to-flight assignment helpers."""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import Iterable

from sqlalchemy import and_
from sqlalchemy.orm import joinedload

from app import (
    Employee,
    Flight,
    RosterEntry,
    StaffRun,
    StaffRunJob,
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


def generate_roster_for_date(target_date: date) -> dict:
    """Populate dated roster entries for a single day from the weekly template."""

    return generate_roster_for_date_range(target_date, target_date)


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


def _format_time_for_assignment(value) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        try:
            return value.strftime("%H:%M")
        except Exception:
            return ""
    if isinstance(value, time):
        return value.strftime("%H:%M")
    try:
        return str(value)
    except Exception:
        return ""


def get_employee_assignments_for_date(target_date: date) -> list[dict]:
    """Return employee → flight assignments for the provided date."""

    flights: list[Flight] = (
        Flight.query.filter(Flight.date == target_date)
        .order_by(Flight.etd_local.asc(), Flight.eta_local.asc(), Flight.id.asc())
        .all()
    )

    run_jobs: list[StaffRunJob] = (
        StaffRunJob.query.join(StaffRun)
        .filter(StaffRun.date == target_date)
        .options(joinedload(StaffRunJob.staff_run).joinedload(StaffRun.staff))
        .all()
    )
    job_by_flight: dict[int, StaffRunJob] = {job.flight_id: job for job in run_jobs}

    assignments: list[dict] = []
    for flight in flights:
        job = job_by_flight.get(flight.id)
        staff_run = job.staff_run if job else None
        staff = staff_run.staff if staff_run else None
        employee = flight.assigned_employee

        staff_code = getattr(staff, "code", None) or getattr(employee, "code", None)
        staff_name = (
            getattr(staff, "name", None)
            or flight.assigned_employee_name
            or getattr(employee, "name", None)
        )
        role = getattr(staff, "role", None) or getattr(employee, "role", None)

        dep_time = _format_time_for_assignment(
            flight.etd_local or flight.time_local or flight.eta_local
        )

        assignments.append(
            {
                "flight_id": flight.id,
                "flight_number": flight.flight_number,
                "dep_time": dep_time,
                "dest": flight.destination,
                "staff_code": staff_code,
                "staff_name": staff_name,
                "role": role,
                "run_id": staff_run.id if staff_run else None,
            }
        )

    return assignments
