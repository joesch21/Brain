import os
from datetime import date, datetime
from zoneinfo import ZoneInfo

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import SYD_TZ, Flight, Run, RunFlight, app, db, ensure_flight_schema, ensure_runs_schema  # noqa: E402
from services.runs_engine import (
    generate_runs_for_date_airline,
    get_runs_for_date_airline,
)  # noqa: E402


class TestRunsEngine:
    def setup_method(self):
        self.client = app.test_client()
        with app.app_context():
            db.drop_all()
            db.create_all()
            ensure_flight_schema()
            ensure_runs_schema()

    def teardown_method(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()

    def _seed_flight(self, flight_number: str, rego: str, etd: datetime, airline: str = "JQ"):
        flight = Flight(
            flight_number=flight_number,
            airline=airline,
            date=etd.date(),
            registration=rego,
            etd_local=etd,
        )
        db.session.add(flight)
        return flight

    def test_generate_runs_orders_flights(self):
        target_date = date(2025, 12, 5)
        tz = ZoneInfo("Australia/Sydney")
        with app.app_context():
            first = self._seed_flight("JQ101", "VH-ABC", datetime(2025, 12, 5, 6, 0, tzinfo=tz))
            second = self._seed_flight("JQ202", "VH-ABC", datetime(2025, 12, 5, 8, 30, tzinfo=tz))
            db.session.commit()

            summary = generate_runs_for_date_airline(target_date, "JQ")
            assert summary["runs_created"] == 1
            assert summary["flights_assigned"] == 2

            run = Run.query.one()
            assert run.registration == "VH-ABC"

            run_flights = RunFlight.query.filter_by(run_id=run.id).order_by(RunFlight.sequence_index).all()
            assert [rf.flight_id for rf in run_flights] == [first.id, second.id]

    def test_generate_runs_splits_by_registration(self):
        target_date = date(2025, 12, 5)
        with app.app_context():
            self._seed_flight("JQ101", "VH-AAA", datetime(2025, 12, 5, 6, 0, tzinfo=SYD_TZ))
            self._seed_flight("JQ202", "VH-BBB", datetime(2025, 12, 5, 8, 30, tzinfo=SYD_TZ))
            db.session.commit()

            summary = generate_runs_for_date_airline(target_date, "JQ")
            assert summary["runs_created"] == 2
            assert summary["flights_assigned"] == 2

            runs = Run.query.order_by(Run.registration).all()
            assert {r.registration for r in runs} == {"VH-AAA", "VH-BBB"}

    def test_generate_runs_is_idempotent(self):
        target_date = date(2025, 12, 5)
        with app.app_context():
            self._seed_flight("JQ101", "VH-AAA", datetime(2025, 12, 5, 6, 0, tzinfo=SYD_TZ))
            self._seed_flight("JQ202", "VH-AAA", datetime(2025, 12, 5, 8, 30, tzinfo=SYD_TZ))
            db.session.commit()

            first_run = generate_runs_for_date_airline(target_date, "JQ")
            second_run = generate_runs_for_date_airline(target_date, "JQ")

            assert first_run == second_run
            runs = Run.query.all()
            assert len(runs) == 1
            run_flights = RunFlight.query.filter_by(run_id=runs[0].id).all()
            assert len(run_flights) == 2

    def test_api_generate_and_fetch_runs(self):
        target_date = date(2025, 12, 5)
        with app.app_context():
            self._seed_flight("JQ101", "VH-AAA", datetime(2025, 12, 5, 6, 0, tzinfo=SYD_TZ))
            self._seed_flight("JQ202", "VH-AAA", datetime(2025, 12, 5, 8, 30, tzinfo=SYD_TZ))
            db.session.commit()

        resp = self.client.post(
            "/api/runs/generate",
            query_string={"date": target_date.isoformat(), "airline": "JQ"},
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["runs_created"] == 1
        assert data["flights_assigned"] == 2

        resp_get = self.client.get(
            "/api/runs",
            query_string={"date": target_date.isoformat(), "airline": "JQ"},
        )
        assert resp_get.status_code == 200
        runs_payload = resp_get.get_json()
        assert runs_payload["ok"] is True
        assert len(runs_payload["runs"]) == 1
        assert len(runs_payload["runs"][0]["flights"]) == 2
        assert runs_payload["runs"][0]["registration"] == "VH-AAA"

    def test_get_runs_for_date_airline_returns_payload(self):
        target_date = date(2025, 12, 5)
        with app.app_context():
            first = self._seed_flight("JQ101", "VH-ZZZ", datetime(2025, 12, 5, 6, 0, tzinfo=SYD_TZ))
            second = self._seed_flight("JQ202", "VH-ZZZ", datetime(2025, 12, 5, 8, 30, tzinfo=SYD_TZ))
            db.session.commit()

            generate_runs_for_date_airline(target_date, "JQ")

            payload = get_runs_for_date_airline(target_date, "JQ")

            assert payload["ok"] is True
            assert payload["date"] == target_date.isoformat()
            assert payload["airline"] == "JQ"
            assert len(payload["runs"]) == 1
            run_payload = payload["runs"][0]
            assert run_payload["registration"] == "VH-ZZZ"
            assert [f["flight_id"] for f in run_payload["flights"]] == [first.id, second.id]
