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

    def test_api_flights_returns_empty_payload_when_no_flights(self):
        target_date = date(2025, 12, 6)

        resp = self.client.get("/api/flights", query_string={"date": target_date.isoformat()})

        assert resp.status_code == 200
        data = resp.get_json()
        assert data == {"date": target_date.isoformat(), "flights": []}

    def test_api_flights_orders_results_by_time(self):
        target_date = date(2025, 12, 6)
        with app.app_context():
            db.session.add(
                Flight(
                    flight_number="JQ300",
                    date=target_date,
                    origin="SYD",
                    destination="MEL",
                    etd_local=datetime(2025, 12, 6, 11, 0, tzinfo=SYD_TZ),
                )
            )
            db.session.add(
                Flight(
                    flight_number="QF100",
                    date=target_date,
                    origin="SYD",
                    destination="BNE",
                    etd_local=datetime(2025, 12, 6, 9, 0, tzinfo=SYD_TZ),
                )
            )
            db.session.commit()

        resp = self.client.get("/api/flights", query_string={"date": target_date.isoformat()})

        assert resp.status_code == 200
        data = resp.get_json()
        assert [f["flight_number"] for f in data["flights"]] == ["QF100", "JQ300"]

    def test_api_flights_accepts_operator_alias(self):
        target_date = date(2025, 12, 6)
        with app.app_context():
            db.session.add(
                Flight(
                    flight_number="JQ400",
                    date=target_date,
                    origin="SYD",
                    destination="MEL",
                )
            )
            db.session.add(
                Flight(
                    flight_number="VA500",
                    date=target_date,
                    origin="SYD",
                    destination="BNE",
                )
            )
            db.session.commit()

        resp = self.client.get(
            "/api/flights", query_string={"date": target_date.isoformat(), "operator": "all"}
        )

        assert resp.status_code == 200
        data = resp.get_json()
        assert len(data["flights"]) == 2
        assert {f["flight_number"] for f in data["flights"]} == {"JQ400", "VA500"}

    def test_api_flights_rejects_invalid_airline(self):
        resp = self.client.get(
            "/api/flights", query_string={"date": date(2025, 12, 6).isoformat(), "airline": "XXX"}
        )

        assert resp.status_code == 400
        assert "Unsupported airline" in resp.get_json().get("error", "")

    def test_import_live_validates_airline_param(self):
        resp = self.client.post("/api/import/live")
        assert resp.status_code == 400

    def test_import_live_runs_with_supported_airline(self):
        with patch("app.run_three_day_import", return_value={"ok": True, "airline": "QF"}) as mock_import:
            resp = self.client.post("/api/import/live", query_string={"airline": "QF"})

        assert resp.status_code == 200
        assert mock_import.called

    def test_import_status_reports_supported_airlines(self):
        resp = self.client.get("/api/ops/import_status")

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["endpoints"]["import_live"] is True
        assert data["supported_airlines"] == ["JQ", "QF", "VA", "ZL"]
        assert set(data["last_import"].keys()) == {"JQ", "QF", "VA", "ZL"}
        assert data["timestamp_source"] == "imported_at"

    def test_import_status_returns_last_import_timestamp(self):
        tz = ZoneInfo("Australia/Sydney")
        with app.app_context():
            db.session.add(
                Flight(
                    flight_number="JQ123",
                    date=date(2025, 12, 5),
                    etd_local=datetime(2025, 12, 5, 2, 0, tzinfo=tz),
                )
            )
            db.session.add(
                Flight(
                    flight_number="QF321",
                    date=date(2025, 12, 6),
                    etd_local=datetime(2025, 12, 6, 6, 30, tzinfo=tz),
                )
            )
            db.session.commit()

        resp = self.client.get("/api/ops/import_status")

        assert resp.status_code == 200
        data = resp.get_json()
        assert data["last_import"]["JQ"].startswith("2025-12-05T02:00:00+")
        assert data["last_import"]["QF"].startswith("2025-12-06T06:30:00+")
