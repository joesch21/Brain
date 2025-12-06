"""Run generation engine.

Groups flights by registration and builds runs for a given date and airline.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session


def _normalize_date(target_date: date | str | datetime) -> date:
    if isinstance(target_date, date) and not isinstance(target_date, datetime):
        return target_date
    if isinstance(target_date, datetime):
        return target_date.date()
    if isinstance(target_date, str):
        return date.fromisoformat(target_date)
    raise ValueError("Unsupported date type; expected date, datetime, or YYYY-MM-DD string")


def generate_runs_for_date_airline(target_date, airline: str) -> dict:
    """Generate runs for the given date and airline.

    Flights are grouped by registration and ordered by ``etd_local``. Existing
    runs for the same date and airline are removed before new ones are created
    to keep the operation idempotent.
    """

    from app import Flight, Run, RunFlight, SYD_TZ, db

    normalized_date = _normalize_date(target_date)
    airline_code = (airline or "").strip().upper()
    if not airline_code:
        raise ValueError("Airline is required")

    session: Session = db.session
    db.create_all()
    session.execute(select(1))  # Ensure a session is available

    # Clean slate for the requested scope
    existing_run_ids = [r.id for r in Run.query.filter_by(date=normalized_date, airline=airline_code).all()]
    if existing_run_ids:
        session.query(RunFlight).filter(RunFlight.run_id.in_(existing_run_ids)).delete(
            synchronize_session=False
        )
    Run.query.filter_by(date=normalized_date, airline=airline_code).delete(synchronize_session=False)

    query = (
        Flight.query.filter(Flight.date == normalized_date)
        .filter(
            or_(
                Flight.airline == airline_code,
                and_(Flight.airline.is_(None), Flight.flight_number.ilike(f"{airline_code}%")),
            )
        )
        .filter(Flight.registration.isnot(None))
        .filter(Flight.etd_local.isnot(None))
    )

    flights_by_rego: dict[str, list] = {}
    for flight in query.all():
        rego = flight.registration
        if not rego:
            continue
        flights_by_rego.setdefault(rego, []).append(flight)

    runs_created = 0
    flights_assigned = 0

    for rego, flights in flights_by_rego.items():
        flights.sort(key=lambda f: f.etd_local)
        start_time = flights[0].etd_local
        end_time = flights[-1].etd_local

        # Ensure timezone awareness for consistency
        if isinstance(start_time, datetime) and start_time.tzinfo is None:
            start_time = start_time.replace(tzinfo=SYD_TZ)
        if isinstance(end_time, datetime) and end_time.tzinfo is None:
            end_time = end_time.replace(tzinfo=SYD_TZ)

        run = Run(
            date=normalized_date,
            airline=airline_code,
            registration=rego,
            start_time=start_time,
            end_time=end_time,
        )
        session.add(run)
        session.flush()

        for position, flight in enumerate(flights):
            session.add(
                RunFlight(
                    run_id=run.id,
                    flight_id=flight.id,
                    sequence_index=position,
                    position=position,
                    planned_time=(flight.etd_local or start_time).time()
                    if flight.etd_local or start_time
                    else None,
                )
            )
            flights_assigned += 1

        runs_created += 1

    session.commit()

    return {
        "date": normalized_date.isoformat(),
        "airline": airline_code,
        "runs_created": runs_created,
        "flights_assigned": flights_assigned,
    }


def get_runs_for_date_airline(target_date, airline: str) -> dict:
    """Return runs with their flights for the given date and airline."""

    from app import Run, RunFlight, SYD_TZ, db

    normalized_date = _normalize_date(target_date)
    airline_code = (airline or "").strip().upper()
    if not airline_code:
        raise ValueError("Airline is required")

    session: Session = db.session
    db.create_all()
    session.execute(select(1))

    runs = (
        Run.query.filter_by(date=normalized_date, airline=airline_code)
        .options(db.selectinload(Run.run_flights).joinedload(RunFlight.flight))
        .order_by(Run.registration.asc())
        .all()
    )

    payload: list[dict] = []
    for run in runs:
        flights_payload: list[dict] = []
        for rf in sorted(
            run.run_flights,
            key=lambda r: r.sequence_index if r.sequence_index is not None else r.position,
        ):
            flight = rf.flight
            etd_local = flight.etd_local if flight else None
            if isinstance(etd_local, datetime) and etd_local.tzinfo is None:
                etd_local = etd_local.replace(tzinfo=SYD_TZ)

            flights_payload.append(
                {
                    "run_id": run.id,
                    "flight_id": flight.id if flight else None,
                    "flight_number": flight.flight_number if flight else None,
                    "etd_local": etd_local.isoformat() if etd_local else None,
                    "sequence_index": rf.sequence_index if rf.sequence_index is not None else rf.position,
                    "status": rf.status,
                }
            )

        payload.append(
            {
                "id": run.id,
                "date": run.date.isoformat(),
                "airline": run.airline,
                "registration": run.registration,
                "label": run.label,
                "truck_id": run.truck_id,
                "start_time": run.start_time.isoformat() if run.start_time else None,
                "end_time": run.end_time.isoformat() if run.end_time else None,
                "flights": flights_payload,
            }
        )

    return {
        "ok": True,
        "date": normalized_date.isoformat(),
        "airline": airline_code,
        "runs": payload,
    }
