from datetime import date, datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import create_engine, text

from scripts.schema_utils import ensure_flights_schema


def _to_datetime(value):
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        return datetime.fromisoformat(value)
    return None


def test_ensure_flights_schema_migrates_time_columns_and_backfills_airline():
    engine = create_engine("sqlite:///:memory:")

    with engine.begin() as conn:
        conn.execute(
            text(
                """
                CREATE TABLE flights (
                    id INTEGER PRIMARY KEY,
                    flight_number TEXT NOT NULL,
                    date DATE NOT NULL,
                    etd_local TIME,
                    eta_local TIME,
                    imported_at TIMESTAMP
                )
                """
            )
        )
        conn.execute(
            text(
                "INSERT INTO flights (flight_number, date, etd_local, eta_local, imported_at)"
                " VALUES (:flight_number, :date, :etd_local, :eta_local, NULL)"
            ),
            {
                "flight_number": "JQ123",
                "date": date(2025, 12, 6),
                "etd_local": "06:30",
                "eta_local": "08:15",
            },
        )

    ensure_flights_schema(engine)
    ensure_flights_schema(engine)  # idempotent

    with engine.connect() as conn:
        columns = {
            row["name"]: row for row in conn.execute(text("PRAGMA table_info('flights')")).mappings()
        }

        assert "airline" in columns
        assert columns["etd_local"]["type"].upper().startswith("TIMESTAMP")
        assert columns["eta_local"]["type"].upper().startswith("TIMESTAMP")

        result = conn.execute(
            text("SELECT airline, etd_local, eta_local, imported_at FROM flights")
        ).mappings().one()

        assert result["airline"] == "JQ"

        syd = ZoneInfo("Australia/Sydney")
        expected_etd = datetime(2025, 12, 6, 6, 30, tzinfo=syd)
        expected_eta = datetime(2025, 12, 6, 8, 15, tzinfo=syd)

        assert _to_datetime(result["etd_local"]) == expected_etd
        assert _to_datetime(result["eta_local"]) == expected_eta
        assert _to_datetime(result["imported_at"]) == expected_etd
