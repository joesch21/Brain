import os
from datetime import date

os.environ["DATABASE_URL"] = "sqlite:///:memory:"

from app import SYD_TZ, parse_scheduled_time  # noqa: E402


def test_parse_scheduled_time_success():
    service_date = date(2025, 12, 5)
    dt_val = parse_scheduled_time(service_date, "16:50")

    assert dt_val is not None
    assert dt_val.year == 2025
    assert dt_val.month == 12
    assert dt_val.day == 5
    assert dt_val.hour == 16
    assert dt_val.minute == 50
    assert dt_val.tzinfo == SYD_TZ


def test_parse_scheduled_time_missing():
    service_date = date(2025, 12, 5)
    assert parse_scheduled_time(service_date, None) is None


def test_parse_scheduled_time_invalid_logs_and_none(caplog):
    service_date = date(2025, 12, 5)
    with caplog.at_level("WARNING"):
        result = parse_scheduled_time(service_date, "16-50", "JQ522")
    assert result is None
