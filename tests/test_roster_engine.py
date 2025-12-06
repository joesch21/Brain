import os
from collections import Counter
from datetime import date, datetime, time
from zoneinfo import ZoneInfo

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import (  # noqa: E402
    Employee,
    Flight,
    RosterEntry,
    WeeklyRosterTemplate,
    app,
    db,
    ensure_flight_schema,
    ensure_roster_schema,
)
from services.roster_engine import (  # noqa: E402
    auto_assign_employees_for_date,
    generate_roster_for_date_range,
)

SYD_TZ = ZoneInfo("Australia/Sydney")


class TestRosterEngine:
    def setup_method(self):
        self.client = app.test_client()
        with app.app_context():
            db.drop_all()
            db.create_all()
            ensure_flight_schema()
            ensure_roster_schema()

    def teardown_method(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()

    def _add_employee(self, name: str, role: str = "refueler") -> Employee:
        emp = Employee(name=name, role=role, shift="Day", base="SYD", active=True)
        db.session.add(emp)
        db.session.commit()
        return emp

    def test_generate_roster_from_template_is_idempotent(self):
        start_date = date(2025, 1, 6)  # Monday
        end_date = date(2025, 1, 7)
        with app.app_context():
            alice = self._add_employee("Alice", role="refueler")
            template = WeeklyRosterTemplate(
                employee_id=alice.id,
                weekday=0,
                role="refueler",
                shift_start=time(6, 0),
                shift_end=time(14, 0),
                truck="Truck-1",
                notes="Day shift",
            )
            template_two = WeeklyRosterTemplate(
                employee_id=alice.id,
                weekday=1,
                role="refueler",
                shift_start=time(6, 0),
                shift_end=time(14, 0),
                truck="Truck-2",
                notes="Second day",
            )
            db.session.add_all([template, template_two])
            db.session.commit()

            first = generate_roster_for_date_range(start_date, end_date)
            assert first["entries_created"] == 2
            assert RosterEntry.query.count() == 2

            second = generate_roster_for_date_range(start_date, end_date)
            assert second["entries_created"] == 0
            assert RosterEntry.query.count() == 2

    def test_auto_assign_balances_by_shift(self):
        target_date = date(2025, 1, 8)
        with app.app_context():
            alice = self._add_employee("Alice", role="refueler")
            bob = self._add_employee("Bob", role="refueler")

            roster_rows = [
                RosterEntry(
                    date=target_date,
                    employee_name=alice.name,
                    role="refueler",
                    shift_start=time(6, 0),
                    shift_end=time(14, 0),
                ),
                RosterEntry(
                    date=target_date,
                    employee_name=bob.name,
                    role="refueler",
                    shift_start=time(6, 0),
                    shift_end=time(14, 0),
                ),
            ]
            flights = [
                Flight(
                    flight_number="JQ100",
                    airline="JQ",
                    date=target_date,
                    etd_local=datetime(2025, 1, 8, 7, 0, tzinfo=SYD_TZ),
                ),
                Flight(
                    flight_number="JQ101",
                    airline="JQ",
                    date=target_date,
                    etd_local=datetime(2025, 1, 8, 8, 0, tzinfo=SYD_TZ),
                ),
                Flight(
                    flight_number="JQ102",
                    airline="JQ",
                    date=target_date,
                    etd_local=datetime(2025, 1, 8, 9, 30, tzinfo=SYD_TZ),
                ),
                Flight(
                    flight_number="JQ400",
                    airline="JQ",
                    date=target_date,
                    etd_local=datetime(2025, 1, 8, 23, 0, tzinfo=SYD_TZ),
                ),
            ]
            db.session.add_all(roster_rows + flights)
            db.session.commit()

            summary = auto_assign_employees_for_date(target_date, "JQ")
            assert summary["assigned"] == 3
            assert summary["unassigned"] == 1

            refreshed = Flight.query.order_by(Flight.flight_number).all()
            assignments = [f.assigned_employee_name for f in refreshed if f.flight_number != "JQ400"]
            counts = Counter(assignments)
            assert max(counts.values()) - min(counts.values()) <= 1
            assert next(f for f in refreshed if f.flight_number == "JQ400").assigned_employee_name is None

    def test_api_employee_assignments_generate(self):
        target_date = date(2025, 1, 9)
        with app.app_context():
            emp = self._add_employee("Charlie", role="refueler")
            db.session.add(
                RosterEntry(
                    date=target_date,
                    employee_name=emp.name,
                    role="refueler",
                    shift_start=time(6, 0),
                    shift_end=time(18, 0),
                )
            )
            db.session.add(
                Flight(
                    flight_number="JQ200",
                    airline="JQ",
                    date=target_date,
                    etd_local=datetime(2025, 1, 9, 7, 45, tzinfo=SYD_TZ),
                )
            )
            db.session.commit()

        resp = self.client.post(
            "/api/employee_assignments/generate",
            json={"date": target_date.isoformat(), "airline": "JQ"},
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["assigned"] == 1
        assert data["total_flights"] == 1

        with app.app_context():
            flight = Flight.query.one()
            assert flight.assigned_employee_name == "Charlie"
