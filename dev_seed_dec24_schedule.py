"""Seed the canonical Dec 24 schedule into the local database.

Usage examples::

    python dev_seed_dec24_schedule.py --wipe-and-seed
    python dev_seed_dec24_schedule.py --seed-date 2024-12-30
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable

from app import (
    Flight,
    app,
    db,
    ensure_flight_schema,
    _parse_bool,
    _parse_date,
    _parse_time,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "dec24_schedule.json"


class SeedResult(dict):
    @property
    def created(self) -> int:
        return int(self.get("created", 0))

    @property
    def updated(self) -> int:
        return int(self.get("updated", 0))

    @property
    def deleted(self) -> int:
        return int(self.get("deleted", 0))

    @property
    def seeded(self) -> int:
        return self.created + self.updated



def load_fixture() -> list[dict]:
    if not FIXTURE_PATH.exists():
        raise FileNotFoundError(f"Fixture not found: {FIXTURE_PATH}")
    return json.loads(FIXTURE_PATH.read_text())



def _wipe_dates(dates: Iterable[str]) -> int:
    dates_set = {d for d in dates if d}
    if not dates_set:
        return 0

    deleted = 0
    for date_str in dates_set:
        date_val = _parse_date(date_str)
        if not date_val:
            continue
        deleted += (
            Flight.query.filter(Flight.date == date_val).delete(synchronize_session=False)
        )
    db.session.commit()
    return deleted



def seed_dec24_schedule(date_str: str | None = None, wipe: bool = False) -> SeedResult:
    """Seed the Dec24 canonical schedule.

    Args:
        date_str: Optional YYYY-MM-DD string to seed a single date.
        wipe: When True, delete existing flights for the target dates before inserting.
    """

    ensure_flight_schema()
    rows = load_fixture()

    if date_str:
        if not _parse_date(date_str):
            raise ValueError("Invalid date format; expected YYYY-MM-DD")
        rows = [r for r in rows if r.get("date") == date_str]

    if not rows:
        return SeedResult(created=0, updated=0, deleted=0, dates=[])

    target_dates = {r.get("date") for r in rows if r.get("date")}
    deleted = _wipe_dates(target_dates) if wipe else 0

    created = 0
    updated = 0

    for row in rows:
        date_val = _parse_date(row.get("date"))
        time_val = _parse_time(row.get("time_local") or row.get("time"))
        if not date_val or not row.get("flight_number"):
            continue

        existing = (
            Flight.query.filter(
                Flight.date == date_val,
                Flight.flight_number == row.get("flight_number"),
                Flight.time_local == time_val,
            )
            .order_by(Flight.id.asc())
            .first()
        )

        if existing:
            f = existing
            updated += 1
        else:
            f = Flight(flight_number=row.get("flight_number"), date=date_val)
            created += 1
            db.session.add(f)

        is_international = _parse_bool(row.get("is_international", False))

        f.time_local = time_val
        f.destination = row.get("destination")
        f.origin = row.get("origin")
        f.operator_code = row.get("operator_code")
        f.aircraft_type = row.get("aircraft_type")
        f.service_profile_code = row.get("service_profile_code")
        f.bay = row.get("bay")
        f.registration = row.get("registration")
        f.status_code = row.get("status_code")
        f.is_international = bool(is_international) if is_international is not None else False
        f.eta_local = time_val or _parse_time(row.get("eta_local"))
        f.etd_local = _parse_time(row.get("etd_local"))
        f.tail_number = row.get("tail_number")
        f.truck_assignment = row.get("truck_assignment")
        f.status = row.get("status")
        f.notes = row.get("notes")

    db.session.commit()

    return SeedResult(
        created=created,
        updated=updated,
        deleted=deleted,
        dates=sorted(target_dates),
    )



def main():
    parser = argparse.ArgumentParser(description="Seed Dec 24 canonical schedule")
    parser.add_argument(
        "--wipe-and-seed",
        action="store_true",
        dest="wipe_and_seed",
        help="Delete flights for the fixture dates before seeding",
    )
    parser.add_argument(
        "--seed-date",
        dest="seed_date",
        help="YYYY-MM-DD to seed only that date",
    )
    args = parser.parse_args()

    with app.app_context():
        result = seed_dec24_schedule(date_str=args.seed_date, wipe=args.wipe_and_seed)
        seeded_dates = ",".join(result.get("dates", []))
        print(
            f"Seeded Dec24 flights: seeded={result.seeded}, created={result.created}, "
            f"updated={result.updated}, deleted={result.deleted}, dates={seeded_dates}"
        )


if __name__ == "__main__":
    main()
