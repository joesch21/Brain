import os
from datetime import date, datetime
from zoneinfo import ZoneInfo
from unittest.mock import patch

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import SYD_TZ, Flight, app, db, ensure_flight_schema  # noqa: E402


class TestImportFlow:
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

    def test_import_sets_etd_and_api_returns_iso(self):
        target_date = date(2025, 12, 5)
        scheduled_str = "16:50"

        with patch("app.syd_today", return_value=target_date), patch(
            "app.build_source_urls", return_value=["http://example.test"]
        ), patch(
            "app.fetch_flights",
            return_value=[
                {
                    "flight_number": "JQ522",
                    "destination": "MEL",
                    "rego": "VH-ABC",
                    "status": "Arrived",
                    "scheduled_time_str": scheduled_str,
                }
            ],
        ):
            resp = self.client.post("/api/import/jq_live")

        assert resp.status_code == 200

        with app.app_context():
            flights = Flight.query.all()
            assert len(flights) == 3
            assert all(f.etd_local is not None for f in flights)

        api_resp = self.client.get("/api/flights", query_string={"date": target_date.isoformat()})
        assert api_resp.status_code == 200
        data = api_resp.get_json()
        assert data["flights"][0]["etd_local"].startswith("2025-12-05T16:50:00")
        assert data["flights"][0]["time_local"] == scheduled_str

        # Ensure timezone offset is preserved in the stored value
        stored_iso = data["flights"][0]["etd_local"]
        parsed = datetime.fromisoformat(stored_iso)
        assert parsed.tzinfo is not None
        assert parsed.tzinfo.utcoffset(parsed) == ZoneInfo("Australia/Sydney").utcoffset(parsed)

    def test_api_flights_can_filter_by_airline(self):
        target_date = date(2025, 12, 5)
        with app.app_context():
            db.session.add(
                Flight(
                    flight_number="JQ100",
                    date=target_date,
                    origin="SYD",
                    destination="OOL",
                )
            )
            db.session.add(
                Flight(
                    flight_number="QF200",
                    date=target_date,
                    origin="SYD",
                    destination="MEL",
                )
            )
            db.session.commit()

        resp = self.client.get(
            "/api/flights", query_string={"date": target_date.isoformat(), "airline": "QF"}
        )

        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["flights"]) == 1
        assert data["flights"][0]["flight_number"] == "QF200"

    def test_import_live_validates_airline_param(self):
        resp = self.client.post("/api/import/live")
        assert resp.status_code == 400

    def test_import_live_runs_with_supported_airline(self):
        with patch("app.run_three_day_import", return_value={"ok": True, "airline": "QF"}) as mock_import:
            resp = self.client.post("/api/import/live", query_string={"airline": "QF"})

        assert resp.status_code == 200
        assert mock_import.called
