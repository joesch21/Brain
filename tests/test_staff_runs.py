import os
from datetime import date, datetime, time

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import (  # noqa: E402
    Flight,
    RosterTemplateDay,
    RosterTemplateWeek,
    Staff,
    StaffRun,
    StaffRunJob,
    SYD_TZ,
    app,
    db,
    ensure_flight_schema,
    ensure_roster_schema,
    ensure_staff_run_schema,
)
from services.staff_runs import (  # noqa: E402
    generate_staff_runs_for_date_airline,
    get_staff_runs_for_date_airline,
)


class TestStaffRuns:
    def setup_method(self):
        self.client = app.test_client()
        with app.app_context():
            db.drop_all()
            db.create_all()
            ensure_flight_schema()
            ensure_roster_schema()
            ensure_staff_run_schema()

    def teardown_method(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()

    def _seed_staff(self, name: str, code: str):
        staff = Staff(name=name, code=code, employment_type="FT")
        db.session.add(staff)
        return staff

    def _seed_roster(self, target_date: date, staff_entries: list[tuple[Staff, time, time]]):
        template = RosterTemplateWeek(name="SYD_JQ_default_week_v1", is_active=True)
        db.session.add(template)
        db.session.flush()

        weekday = target_date.weekday()
        for staff, start, end in staff_entries:
            db.session.add(
                RosterTemplateDay(
                    template_id=template.id,
                    weekday=weekday,
                    staff_id=staff.id,
                    start_local=start,
                    end_local=end,
                    role="operator",
                )
            )

    def _seed_flight(self, flight_number: str, etd: datetime, airline: str = "JQ"):
        flight = Flight(
            flight_number=flight_number,
            airline=airline,
            date=etd.date(),
            etd_local=etd,
        )
        db.session.add(flight)
        return flight

    def test_generate_staff_runs_assigns_greedily(self):
        target_date = date(2024, 12, 30)
        with app.app_context():
            staff_a = self._seed_staff("Mary Green", "MG")
            staff_b = self._seed_staff("John Blue", "JB")
            db.session.flush()

            self._seed_roster(
                target_date,
                [
                    (staff_a, time(5, 0), time(15, 0)),
                    (staff_b, time(6, 0), time(14, 0)),
                ],
            )

            first = self._seed_flight(
                "JQ603",
                datetime(2024, 12, 30, 5, 30, tzinfo=SYD_TZ),
            )
            second = self._seed_flight(
                "JQ610",
                datetime(2024, 12, 30, 6, 30, tzinfo=SYD_TZ),
            )
            third = self._seed_flight(
                "JQ650",
                datetime(2024, 12, 30, 9, 0, tzinfo=SYD_TZ),
            )
            db.session.commit()

            summary = generate_staff_runs_for_date_airline(target_date, "JQ")

            assert summary["staff_runs_created"] == 2
            assert summary["flights_assigned"] == 3
            assert summary["flights_unassigned"] == 0

            runs = StaffRun.query.order_by(StaffRun.shift_start).all()
            assert len(runs) == 2

            jobs_a = StaffRunJob.query.filter_by(staff_run_id=runs[0].id).order_by(StaffRunJob.sequence).all()
            jobs_b = StaffRunJob.query.filter_by(staff_run_id=runs[1].id).order_by(StaffRunJob.sequence).all()

            assert [job.flight_id for job in jobs_a] == [first.id, third.id]
            assert [job.flight_id for job in jobs_b] == [second.id]

    def test_unassigned_when_no_shift_covers(self):
        target_date = date(2024, 12, 31)
        with app.app_context():
            staff_a = self._seed_staff("Mary Green", "MG")
            db.session.flush()

            self._seed_roster(target_date, [(staff_a, time(5, 0), time(10, 0))])

            assigned = self._seed_flight(
                "JQ700",
                datetime(2024, 12, 31, 6, 0, tzinfo=SYD_TZ),
            )
            unassigned = self._seed_flight(
                "JQ799",
                datetime(2024, 12, 31, 23, 10, tzinfo=SYD_TZ),
            )
            db.session.commit()

            summary = generate_staff_runs_for_date_airline(target_date, "JQ")
            assert summary["flights_assigned"] == 1
            assert summary["flights_unassigned"] == 1

            payload = get_staff_runs_for_date_airline(target_date, "JQ")
            assert len(payload["runs"]) == 1
            assert payload["unassigned"][0]["flight_id"] == unassigned.id
            assert payload["runs"][0]["jobs"][0]["flight_id"] == assigned.id

    def test_generate_staff_runs_is_idempotent(self):
        target_date = date(2025, 1, 1)
        with app.app_context():
            staff_a = self._seed_staff("Mary Green", "MG")
            db.session.flush()
            self._seed_roster(target_date, [(staff_a, time(5, 0), time(15, 0))])
            self._seed_flight(
                "JQ800",
                datetime(2025, 1, 1, 6, 0, tzinfo=SYD_TZ),
            )
            db.session.commit()

            first = generate_staff_runs_for_date_airline(target_date, "JQ")
            second = generate_staff_runs_for_date_airline(target_date, "JQ")

            assert first == second

            runs = StaffRun.query.all()
            assert len(runs) == 1
            jobs = StaffRunJob.query.filter_by(staff_run_id=runs[0].id).all()
            assert len(jobs) == 1

    def test_api_generate_and_fetch_staff_runs(self):
        target_date = date(2025, 1, 2)
        with app.app_context():
            staff_a = self._seed_staff("Mary Green", "MG")
            db.session.flush()
            self._seed_roster(target_date, [(staff_a, time(5, 0), time(15, 0))])
            self._seed_flight(
                "JQ900",
                datetime(2025, 1, 2, 6, 0, tzinfo=SYD_TZ),
            )
            db.session.commit()

        resp = self.client.post(
            "/api/staff_runs/generate",
            query_string={"date": target_date.isoformat(), "airline": "JQ"},
        )
        assert resp.status_code == 200
        payload = resp.get_json()
        assert payload["ok"] is True
        assert payload["summary"]["staff_runs_created"] == 1

        resp_get = self.client.get(
            "/api/staff_runs",
            query_string={"date": target_date.isoformat(), "airline": "JQ"},
        )
        assert resp_get.status_code == 200
        data = resp_get.get_json()
        assert data["ok"] is True
        assert len(data["runs"]) == 1
        assert len(data["runs"][0]["jobs"]) == 1
        assert data["runs"][0]["jobs"][0]["flight_number"] == "JQ900"
