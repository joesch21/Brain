
"""Schema utilities for lightweight migrations.

Provides helpers to ensure newly added columns exist on legacy databases
without requiring a full Alembic setup.
"""

from __future__ import annotations

from sqlalchemy import inspect, text
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
    "airline": "VARCHAR(8)",
}


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
