from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, time, timedelta
from typing import TYPE_CHECKING, Iterable

from sqlalchemy import and_, or_

from services.roster import get_daily_roster

if TYPE_CHECKING:  # pragma: no cover
    from app import Flight, StaffRun, StaffRunJob

# Tunable constants for the greedy assignment logic
JOB_DURATION = timedelta(minutes=45)
MIN_GAP = timedelta(minutes=30)


def _parse_time(value: str | None) -> time | None:
    if not value:
        return None
    return datetime.strptime(value, "%H:%M").time()


def _get_models():
    from app import Flight, StaffRun, StaffRunJob, db

    return Flight, StaffRun, StaffRunJob, db


def _flight_matches_airline(flight: Flight, airline: str) -> bool:
    if flight.airline and flight.airline.upper() == airline.upper():
        return True
    return (flight.flight_number or "").upper().startswith(airline.upper())


def _eligible_flights(target_date: date, airline: str) -> list[Flight]:
    Flight, _, _, _ = _get_models()
    flights: Iterable[Flight] = (
        Flight.query.filter(
            and_(
                Flight.date == target_date,
                Flight.etd_local.isnot(None),
                or_(
                    Flight.flight_number.ilike(f"{airline}%"),
                    Flight.airline == airline,
                ),
            )
        )
        .order_by(Flight.etd_local)
        .all()
    )
    return [flight for flight in flights if _flight_matches_airline(flight, airline)]


def _eligible_shifts(roster: dict) -> list[dict]:
    filtered = []
    for shift in roster.get("shifts", []):
        if shift.get("role") != "operator":
            continue
        filtered.append(
            {
                **shift,
                "start_time": _parse_time(shift.get("start_local")),
                "end_time": _parse_time(shift.get("end_local")),
                "assigned_jobs": [],
                "last_job_end_time": None,
            }
        )
    return filtered


def _shift_window_for_flight(shift: dict, target_date: date, tzinfo) -> tuple[datetime, datetime] | None:
    start_time = shift.get("start_time")
    end_time = shift.get("end_time")
    if not start_time or not end_time:
        return None
    shift_start_dt = datetime.combine(target_date, start_time).replace(tzinfo=tzinfo)
    shift_end_dt = datetime.combine(target_date, end_time).replace(tzinfo=tzinfo)
    return shift_start_dt, shift_end_dt


def generate_staff_runs_for_date_airline(target_date: date, airline: str) -> dict:
    """Generate staff runs for the given date and airline."""

    Flight, StaffRun, StaffRunJob, db = _get_models()
    roster = get_daily_roster(target_date)
    shifts = _eligible_shifts(roster)
    flights = _eligible_flights(target_date, airline)

    unassigned: list[Flight] = []

    for flight in flights:
        etd_local = flight.etd_local
        if etd_local is None:
            continue

        candidates = []
        for shift in shifts:
            window = _shift_window_for_flight(shift, target_date, etd_local.tzinfo)
            if not window:
                continue
            shift_start_dt, shift_end_dt = window

            if not (shift_start_dt <= etd_local <= shift_end_dt - JOB_DURATION):
                continue

            last_end = shift.get("last_job_end_time") or shift_start_dt
            if last_end > etd_local - MIN_GAP:
                continue

            candidates.append((shift, last_end))

        if candidates:
            chosen, _ = min(
                candidates,
                key=lambda item: (len(item[0]["assigned_jobs"]), item[1]),
            )
            chosen["assigned_jobs"].append(flight)
            chosen["last_job_end_time"] = etd_local + JOB_DURATION
        else:
            unassigned.append(flight)

    existing_run_ids = [
        run.id
        for run in StaffRun.query.with_entities(StaffRun.id)
        .filter_by(date=target_date, airline=airline)
        .all()
    ]
    if existing_run_ids:
        StaffRunJob.query.filter(StaffRunJob.staff_run_id.in_(existing_run_ids)).delete(
            synchronize_session=False
        )
    StaffRun.query.filter_by(date=target_date, airline=airline).delete(
        synchronize_session=False
    )

    created_runs = 0
    assigned_jobs = 0

    for shift in shifts:
        jobs: list[Flight] = shift.get("assigned_jobs", [])
        if not jobs:
            continue

        staff_run = StaffRun(
            date=target_date,
            airline=airline,
            staff_id=shift.get("staff_id"),
            shift_start=shift.get("start_time"),
            shift_end=shift.get("end_time"),
        )
        db.session.add(staff_run)
        db.session.flush()

        for idx, flight in enumerate(jobs):
            job = StaffRunJob(
                staff_run_id=staff_run.id,
                flight_id=flight.id,
                sequence=idx,
            )
            db.session.add(job)
            assigned_jobs += 1

        created_runs += 1

    db.session.commit()

    return {
        "date": target_date.isoformat(),
        "airline": airline,
        "staff_runs_created": created_runs,
        "flights_assigned": assigned_jobs,
        "flights_unassigned": len(unassigned),
    }


def get_staff_runs_for_date_airline(target_date: date, airline: str) -> dict:
    Flight, StaffRun, StaffRunJob, _ = _get_models()
    runs = (
        StaffRun.query.filter_by(date=target_date, airline=airline)
        .order_by(StaffRun.shift_start)
        .all()
    )

    run_ids = [r.id for r in runs]
    jobs_by_run: dict[int, list[StaffRunJob]] = defaultdict(list)
    if run_ids:
        job_rows = (
            StaffRunJob.query.join(Flight)
            .filter(StaffRunJob.staff_run_id.in_(run_ids))
            .order_by(StaffRunJob.staff_run_id, StaffRunJob.sequence)
            .all()
        )
        for job in job_rows:
            jobs_by_run[job.staff_run_id].append(job)

    runs_payload = []
    for run in runs:
        staff = run.staff
        runs_payload.append(
            {
                "id": run.id,
                "date": run.date.isoformat(),
                "airline": run.airline,
                "staff_id": staff.id if staff else run.staff_id,
                "staff_code": getattr(staff, "code", None),
                "staff_name": getattr(staff, "name", None),
                "shift_start": run.shift_start.strftime("%H:%M") if run.shift_start else None,
                "shift_end": run.shift_end.strftime("%H:%M") if run.shift_end else None,
                "jobs": [
                    {
                        "sequence": job.sequence,
                        "flight_id": job.flight_id,
                        "flight_number": job.flight.flight_number if job.flight else None,
                        "etd_local": job.flight.etd_local.isoformat() if job.flight and job.flight.etd_local else None,
                    }
                    for job in jobs_by_run.get(run.id, [])
                ],
            }
        )

    flights = _eligible_flights(target_date, airline)
    assigned_flight_ids = {job.flight_id for job_list in jobs_by_run.values() for job in job_list}
    unassigned = [
        {
            "flight_id": flight.id,
            "flight_number": flight.flight_number,
            "etd_local": flight.etd_local.isoformat() if flight.etd_local else None,
        }
        for flight in flights
        if flight.id not in assigned_flight_ids
    ]

    return {
        "date": target_date.isoformat(),
        "airline": airline,
        "runs": runs_payload,
        "unassigned": unassigned,
        "ok": True,
    }
