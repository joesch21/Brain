import os
from datetime import date, datetime
from zoneinfo import ZoneInfo

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import SYD_TZ, Flight, Run, RunFlight, app, db, ensure_flight_schema  # noqa: E402
from services.runs_engine import generate_runs_for_date_airline  # noqa: E402


class TestRunsEngine:
    def setup_method(self):
        self.client = app.test_client()
        with app.app_context():
            db.drop_all()
            db.create_all()
            ensure_flight_schema()

    def teardown_method(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()

    def _add_flight(self, **kwargs):
        with app.app_context():
            flight = Flight(**kwargs)
            db.session.add(flight)
            db.session.commit()
            return flight

    def test_generate_single_registration_orders_flights(self):
        target_date = date(2025, 12, 5)
        early = datetime(2025, 12, 5, 6, 0, tzinfo=SYD_TZ)
        late = datetime(2025, 12, 5, 18, 30, tzinfo=SYD_TZ)

        self._add_flight(
            flight_number="JQ501",
            airline="JQ",
            date=target_date,
            registration="VH-ABC",
            etd_local=late,
        )
        self._add_flight(
            flight_number="JQ502",
            airline="JQ",
            date=target_date,
            registration="VH-ABC",
            etd_local=early,
        )

        with app.app_context():
            summary = generate_runs_for_date_airline(target_date, "JQ")
        assert summary["runs_created"] == 1
        assert summary["flights_assigned"] == 2

        with app.app_context():
            run = Run.query.one()
            assert run.registration == "VH-ABC"
            assert run.start_time.hour == early.hour
            assert run.start_time.minute == early.minute
            assert run.end_time.hour == late.hour
            assert run.end_time.minute == late.minute

            positions = [rf.position for rf in RunFlight.query.order_by(RunFlight.position).all()]
            assert positions == [0, 1]

    def test_generate_creates_one_run_per_registration(self):
        target_date = date(2025, 12, 6)
        etd = datetime(2025, 12, 6, 9, 0, tzinfo=SYD_TZ)

        self._add_flight(
            flight_number="JQ100",
            airline="JQ",
            date=target_date,
            registration="VH-AAA",
            etd_local=etd,
        )
        self._add_flight(
            flight_number="JQ200",
            airline="JQ",
            date=target_date,
            registration="VH-BBB",
            etd_local=etd,
        )

        with app.app_context():
            summary = generate_runs_for_date_airline(target_date, "JQ")
        assert summary["runs_created"] == 2

        with app.app_context():
            runs = Run.query.order_by(Run.registration).all()
            assert [r.registration for r in runs] == ["VH-AAA", "VH-BBB"]
            assert all(len(r.run_flights) == 1 for r in runs)

    def test_generate_is_idempotent(self):
        target_date = date(2025, 12, 7)
        etd = datetime(2025, 12, 7, 10, 0, tzinfo=SYD_TZ)

        self._add_flight(
            flight_number="JQ300",
            airline="JQ",
            date=target_date,
            registration="VH-IDM",
            etd_local=etd,
        )

        with app.app_context():
            first = generate_runs_for_date_airline(target_date, "JQ")
            second = generate_runs_for_date_airline(target_date, "JQ")

        assert first["runs_created"] == 1
        assert second["runs_created"] == 1

        with app.app_context():
            assert Run.query.count() == 1
            run = Run.query.one()
            assert len(run.run_flights) == 1

    def test_api_generate_and_fetch_runs(self):
        target_date = date(2025, 12, 8)
        etd = datetime(2025, 12, 8, 12, 15, tzinfo=ZoneInfo("Australia/Sydney"))

        self._add_flight(
            flight_number="JQ400",
            airline="JQ",
            date=target_date,
            registration="VH-API",
            etd_local=etd,
        )

        resp = self.client.post(
            "/api/runs/generate",
            query_string={"date": target_date.isoformat(), "airline": "JQ"},
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["runs_created"] == 1

        resp = self.client.get(
            "/api/runs",
            query_string={"date": target_date.isoformat(), "airline": "JQ"},
        )
        assert resp.status_code == 200

        runs = resp.get_json()
        assert len(runs) == 1
        assert runs[0]["registration"] == "VH-API"
        assert len(runs[0]["flights"]) == 1
        assert runs[0]["flights"][0]["position"] == 0
