
"""Schema utilities for lightweight migrations.

Provides helpers to ensure newly added columns exist on legacy databases
without requiring a full Alembic setup.
"""

from __future__ import annotations

from datetime import datetime, time as dt_time
from zoneinfo import ZoneInfo

from sqlalchemy import Time, inspect, text
from sqlalchemy.engine import Engine


# ``is_international`` is handled by app.ensure_flight_schema with
# database-specific defaults. Keep the rest of the lightweight columns here.
FLIGHT_NEW_COLUMNS: dict[str, str] = {
    "time_local": "TIME",
    "operator_code": "VARCHAR(16)",
    "aircraft_type": "VARCHAR(32)",
    "service_profile_code": "VARCHAR(64)",
    "bay": "VARCHAR(32)",
    "registration": "VARCHAR(32)",
    "status_code": "VARCHAR(32)",
}

SYD_TZ_NAME = "Australia/Sydney"


def _existing_columns(engine: Engine, table: str) -> set[str]:
    inspector = inspect(engine)
    return {col["name"] for col in inspector.get_columns(table)}


def ensure_columns(engine: Engine, table: str, columns: dict[str, str]) -> list[str]:
    """Add any missing columns defined in ``columns``.

    Returns a list of column names that were added. Designed to work on both
    SQLite and PostgreSQL with simple ``ALTER TABLE ... ADD COLUMN`` statements.
    """

    added: list[str] = []
    existing = _existing_columns(engine, table)

    for col_name, ddl in columns.items():
        if col_name in existing:
            continue

        # SQLite and Postgres both support basic ADD COLUMN syntax.
        sql = text(f"ALTER TABLE {table} ADD COLUMN {col_name} {ddl}")
        with engine.begin() as conn:
            conn.execute(sql)
        added.append(col_name)
        existing.add(col_name)

    return added


def ensure_flight_columns(engine: Engine) -> list[str]:
    """Ensure the flights table has the new canonical fields."""

    return ensure_columns(engine, "flights", FLIGHT_NEW_COLUMNS)


def _refresh_columns(engine: Engine, table: str) -> dict[str, dict]:
    inspector = inspect(engine)
    return {col["name"]: col for col in inspector.get_columns(table)}


def _add_column(engine: Engine, table: str, column: str, ddl: str, actions: list[str]):
    sql = text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")
    with engine.begin() as conn:
        conn.execute(sql)
    actions.append(f"added:{table}.{column}")


def _backfill_airline(engine: Engine) -> None:
    if engine.dialect.name == "postgresql":
        update_sql = text(
            "UPDATE flights "
            "SET airline = UPPER(REGEXP_REPLACE(flight_number, '[^A-Za-z].*$', '')) "
            "WHERE airline IS NULL "
            "AND flight_number ~ '^[A-Za-z]{2}'"
        )
        with engine.begin() as conn:
            conn.execute(update_sql)
        return

    # SQLite fallback: backfill via Python-safe parsing
    with engine.begin() as conn:
        rows = conn.execute(
            text("SELECT id, flight_number FROM flights WHERE airline IS NULL")
        ).mappings()
        for row in rows:
            flight_number = row["flight_number"] or ""
            prefix = ""
            for char in flight_number:
                if char.isalpha():
                    prefix += char
                else:
                    break
            airline = prefix.upper() if len(prefix) >= 2 else None
            if airline:
                conn.execute(
                    text("UPDATE flights SET airline = :airline WHERE id = :id"),
                    {"airline": airline, "id": row["id"]},
                )


def _convert_time_column_to_timestamptz(engine: Engine, column: str, actions: list[str]):
    columns = _refresh_columns(engine, "flights")
    col = columns.get(column)
    if not col:
        return

    col_type = col.get("type")
    is_time_without_tz = isinstance(col_type, Time) and getattr(col_type, "timezone", None) is False
    if not is_time_without_tz:
        return

    if engine.dialect.name == "postgresql":
        alter_sql = text(
            f"ALTER TABLE flights "
            f"ALTER COLUMN {column} TYPE TIMESTAMPTZ "
            f"USING timezone('{SYD_TZ_NAME}', (date::timestamp + {column}))"
        )
        with engine.begin() as conn:
            conn.execute(alter_sql)
        actions.append(f"altered:{column}:timestamptz")
        return

    # SQLite fallback: rename old column, create new TIMESTAMP column, backfill
    legacy_col = f"{column}_legacy"
    with engine.begin() as conn:
        conn.execute(text(f"ALTER TABLE flights RENAME COLUMN {column} TO {legacy_col}"))
        conn.execute(text(f"ALTER TABLE flights ADD COLUMN {column} TIMESTAMP"))

        rows = conn.execute(
            text(f"SELECT id, date, {legacy_col} FROM flights")
        ).mappings()

        for row in rows:
            raw_value = row[legacy_col]
            if raw_value is None:
                continue

            if isinstance(raw_value, str):
                parsed_time = dt_time.fromisoformat(raw_value)
            else:
                parsed_time = raw_value

            row_date = row["date"]
            if isinstance(row_date, str):
                row_date = datetime.fromisoformat(row_date).date()

            combined = datetime.combine(row_date, parsed_time, tzinfo=ZoneInfo(SYD_TZ_NAME))
            conn.execute(
                text(f"UPDATE flights SET {column} = :dt WHERE id = :id"),
                {"dt": combined.isoformat(), "id": row["id"]},
            )

        try:
            conn.execute(text(f"ALTER TABLE flights DROP COLUMN {legacy_col}"))
        except Exception:  # noqa: BLE001
            # Best-effort cleanup; SQLite may not support DROP COLUMN
            pass

    actions.append(f"altered:{column}:timestamp")


def ensure_flights_schema(engine: Engine) -> list[str]:
    """Ensure the flights table matches the daa586a contract.

    The helper is idempotent and safe to run multiple times. It inspects the
    current schema before applying any DDL to avoid unnecessary locks.
    """

    inspector = inspect(engine)
    if "flights" not in inspector.get_table_names():
        return []

    actions: list[str] = []
    columns = {col["name"]: col for col in inspector.get_columns("flights")}

    try:
        if "etd_local" not in columns:
            ddl = (
                "TIMESTAMP WITH TIME ZONE"
                if engine.dialect.name == "postgresql"
                else "TIMESTAMP"
            )
            _add_column(engine, "flights", "etd_local", ddl, actions)
            columns = _refresh_columns(engine, "flights")

        if "imported_at" not in columns:
            ddl = (
                "TIMESTAMP WITH TIME ZONE"
                if engine.dialect.name == "postgresql"
                else "TIMESTAMP"
            )
            _add_column(engine, "flights", "imported_at", ddl, actions)
            columns = _refresh_columns(engine, "flights")

        if "airline" not in columns:
            _add_column(engine, "flights", "airline", "VARCHAR(4)", actions)
            columns = _refresh_columns(engine, "flights")

        _convert_time_column_to_timestamptz(engine, "etd_local", actions)
        _convert_time_column_to_timestamptz(engine, "eta_local", actions)

        _backfill_airline(engine)
        actions.append("backfilled:airline")

        with engine.begin() as conn:
            conn.execute(
                text(
                    "UPDATE flights "
                    "SET imported_at = COALESCE(imported_at, etd_local, CURRENT_TIMESTAMP)"
                )
            )
        actions.append("backfilled:imported_at")

        actions.extend(ensure_flight_columns(engine))

        return actions
    except Exception:  # noqa: BLE001
        print("[schema] Failed to ensure flight schema", flush=True)
        raise
