"""Office DB adapters for Code_Crafter2."""
from __future__ import annotations

import os
from datetime import date
from typing import Any, Dict, List, Optional

from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine

_office_engine: Optional[Engine] = None


def _normalize_uri(uri: str) -> str:
    """Normalize legacy postgres URI schemes for SQLAlchemy."""
    if uri.startswith("postgres://"):
        return uri.replace("postgres://", "postgresql://", 1)
    return uri


def _get_office_engine() -> Optional[Engine]:
    """Return a cached SQLAlchemy engine for the Office DB if configured."""
    global _office_engine

    if _office_engine is not None:
        return _office_engine

    uri = os.getenv("OFFICE_DB_URL")
    if not uri:
        return None

    _office_engine = create_engine(_normalize_uri(uri), future=True)
    return _office_engine


def use_office_db() -> bool:
    """Flag indicating whether Office DB querying is enabled."""
    return os.getenv("USE_OFFICE_DB", "0") not in {"0", "false", "False"}


def fetch_office_flights_for_date(day: date) -> List[Dict[str, Any]]:
    """Placeholder adapter for office flights; customize for your schema."""
    engine = _get_office_engine()
    if engine is None:
        raise RuntimeError("Office DB engine not available")

    sql = text(
        """
        SELECT id, flight_number, destination, time_local
        FROM office_flights
        WHERE flight_date::date = :day
        ORDER BY time_local NULLS LAST, flight_number
        """
    )

    flights: List[Dict[str, Any]] = []
    with engine.begin() as conn:
        for row in conn.execute(sql, {"day": day}).mappings():
            time_val = row.get("time_local")
            flights.append(
                {
                    "id": row.get("id"),
                    "flight_number": row.get("flight_number"),
                    "destination": row.get("destination"),
                    "time_local": time_val.strftime("%H:%M") if time_val else None,
                }
            )

    return flights


def fetch_office_runs_for_date(day: date) -> List[Dict[str, Any]]:
    """
    Read-only query to fetch runs (and their flights) for a given date
    from the Refuelling Office Manager DB.

    IMPORTANT:
      - You MUST customise the SQL to match the real office tables.
      - This version assumes THREE tables:

        office_runs(
          id          serial primary key,
          name        text,
          operator    text,
          run_date    date,
          shift_band  text      -- e.g. 'AM', 'Midday', 'Evening', 'Unscheduled'
        )

        office_run_flights(
          id           serial primary key,
          run_id       int references office_runs(id),
          flight_id    int references office_flights(id),
          seq_index    int
        )

        office_flights(
          id              serial primary key,
          flight_number   text,
          destination     text,
          flight_date     date,
          time_local      time
        )

      - The return shape is what The Brain's Planner expects:

        [
          {
            "id": 1,
            "name": "Truck 1",
            "operator": "Ampol 1",
            "shift_band": "AM",
            "flights": [
              {
                "id": 101,                # flight_run id
                "sequence_index": 1,
                "flight": {
                  "id": 5001,
                  "flight_number": "QF400",
                  "destination": "MEL",
                  "time_local": "06:15"
                }
              },
              ...
            ]
          },
          ...
        ]
    """
    engine = _get_office_engine()
    if engine is None:
        raise RuntimeError("Office DB engine not available")

    # TODO: adjust table + column names to match the real office schema.
    sql = text(
        """
        SELECT
          r.id              AS run_id,
          r.name            AS run_name,
          r.operator        AS operator,
          r.shift_band      AS shift_band,

          rf.id             AS flight_run_id,
          rf.seq_index      AS sequence_index,

          f.id              AS flight_id,
          f.flight_number   AS flight_number,
          f.destination     AS destination,
          f.time_local      AS time_local
        FROM office_runs r
        LEFT JOIN office_run_flights rf
          ON rf.run_id = r.id
        LEFT JOIN office_flights f
          ON f.id = rf.flight_id
        WHERE r.run_date::date = :day
        ORDER BY
          r.shift_band,
          r.id,
          rf.seq_index NULLS LAST,
          f.time_local NULLS LAST,
          f.flight_number
        """
    )

    runs_by_id: Dict[int, Dict[str, Any]] = {}

    with engine.begin() as conn:
        for row in conn.execute(sql, {"day": day}).mappings():
            run_id = row["run_id"]
            if run_id is None:
                # Should not happen, but be defensive.
                continue

            run = runs_by_id.get(run_id)
            if run is None:
                run = {
                    "id": run_id,
                    "name": row.get("run_name"),
                    "operator": row.get("operator"),
                    "shift_band": row.get("shift_band"),
                    "flights": [],
                }
                runs_by_id[run_id] = run

            # If this run has a linked flight, add it
            if row["flight_run_id"] is not None:
                time_val = row["time_local"]
                run["flights"].append(
                    {
                        "id": row["flight_run_id"],
                        "sequence_index": row["sequence_index"],
                        "flight": {
                            "id": row["flight_id"],
                            "flight_number": row["flight_number"],
                            "destination": row["destination"],
                            "time_local": time_val.strftime("%H:%M")
                            if time_val is not None
                            else None,
                        },
                    }
                )

    # Convert dict → list for JSON response
    return list(runs_by_id.values())
