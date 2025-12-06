import os
from datetime import date, time

import pytest

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import (  # noqa: E402
    RosterTemplateDay,
    RosterTemplateWeek,
    Staff,
    app,
    db,
    ensure_roster_schema,
)
from services.roster import get_daily_roster  # noqa: E402


class TestDailyRoster:
    def setup_method(self):
        self.client = app.test_client()
        with app.app_context():
            db.drop_all()
            db.create_all()
            ensure_roster_schema()

    def teardown_method(self):
        with app.app_context():
            db.session.remove()
            db.drop_all()

    def _seed_template(self):
        staff = Staff(
            name="Mary Green",
            code="MG",
            employment_type="FT",
            weekly_hours_target=38,
            active=True,
        )
        db.session.add(staff)
        db.session.flush()

        template = RosterTemplateWeek(
            name="SYD_JQ_default_week_v1",
            description="Seeded week",
            is_active=True,
        )
        db.session.add(template)
        db.session.flush()

        db.session.add(
            RosterTemplateDay(
                template_id=template.id,
                weekday=0,
                staff_id=staff.id,
                start_local=time(5, 0),
                end_local=time(15, 0),
                role="operator",
            )
        )
        db.session.commit()
        return staff, template

    def test_get_daily_roster_returns_expected_shifts(self):
        target_date = date(2024, 12, 30)  # Monday
        with app.app_context():
            staff, template = self._seed_template()
            roster = get_daily_roster(target_date)

        assert roster["date"] == target_date.isoformat()
        assert roster["template_id"] == template.id
        assert len(roster["shifts"]) == 1
        shift = roster["shifts"][0]
        assert shift["staff_id"] == staff.id
        assert shift["staff_code"] == "MG"
        assert shift["start_local"] == "05:00"
        assert shift["role"] == "operator"

    def test_api_daily_roster_happy_path(self):
        target_date = date(2024, 12, 30)
        with app.app_context():
            self._seed_template()

        resp = self.client.get(f"/api/roster/daily?date={target_date.isoformat()}")
        assert resp.status_code == 200
        payload = resp.get_json()
        assert payload["ok"] is True
        assert payload["roster"]["date"] == target_date.isoformat()
        assert len(payload["roster"]["shifts"]) == 1

    @pytest.mark.parametrize("bad_date", ["2024-13-01", "", None])
    def test_api_daily_roster_validation_errors(self, bad_date):
        query = f"/api/roster/daily?date={bad_date}" if bad_date else "/api/roster/daily"
        resp = self.client.get(query)
        assert resp.status_code == 400
        payload = resp.get_json()
        assert payload["ok"] is False
        assert payload["type"] == "validation_error"
