"""Lightweight runs engine grouping flights by registration and etd_local."""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from typing import Dict

from sqlalchemy import or_


def generate_runs_for_date_airline(target_date: date, airline: str) -> Dict[str, int | str]:
    """Generate runs for a given service date and airline.

    Flights are grouped by registration and ordered by ``etd_local``. Existing
    runs for the same date + airline are removed so the operation is idempotent.
    """

    if target_date is None:
        raise ValueError("target_date is required")
    if not airline:
        raise ValueError("airline is required")

    # Local import to avoid circular references during Flask startup
    from app import Flight, Run, RunFlight, db

    flights_query = Flight.query.filter(
        Flight.date == target_date,
        Flight.registration.isnot(None),
        Flight.etd_local.isnot(None),
        or_(
            Flight.airline == airline,
            Flight.flight_number.ilike(f"{airline}%"),
        ),
    )
    flights = flights_query.all()

    existing_runs = Run.query.filter_by(date=target_date, airline=airline).all()
    for run in existing_runs:
        db.session.delete(run)
    db.session.flush()

    flights_by_rego: dict[str, list[Flight]] = defaultdict(list)
    for flight in flights:
        flights_by_rego[flight.registration].append(flight)

    runs_created = 0
    flights_assigned = 0

    for registration, rego_flights in flights_by_rego.items():
        sorted_flights = sorted(rego_flights, key=lambda f: f.etd_local)
        start_time = sorted_flights[0].etd_local if sorted_flights else None
        end_time = sorted_flights[-1].etd_local if sorted_flights else None

        run = Run(
            date=target_date,
            airline=airline,
            registration=registration,
            start_time=start_time,
            end_time=end_time,
        )
        db.session.add(run)
        db.session.flush()

        for idx, flight in enumerate(sorted_flights):
            db.session.add(
                RunFlight(run_id=run.id, flight_id=flight.id, position=idx)
            )
            flights_assigned += 1

        runs_created += 1

    db.session.commit()

    return {
        "date": target_date.isoformat(),
        "airline": airline,
        "runs_created": runs_created,
        "flights_assigned": flights_assigned,
    }
