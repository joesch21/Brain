"""Lightweight Jetstar live import helpers.

These helpers fetch the public schedule HTML, parse out JQ flights, and
return a summary of how many flights were discovered per day. The actual
persistence layer can be wired into ``_upsert_flights_for_day`` when the
ORM/table is available.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup

AIRLINE_CODE = "JQ"


def _get_today_in_tz() -> date:
    tz_name = os.getenv("JQ_SCHEDULE_TZ", "Australia/Sydney")
    tz = ZoneInfo(tz_name)
    now = datetime.now(tz)
    return now.date()


def _build_url_for_day(day: date) -> str:
    base = os.environ.get("OPS_SCHEDULE_URL_JQ")
    if not base:
        raise RuntimeError("OPS_SCHEDULE_URL_JQ not set")

    if "{DATE}" in base:
        return base.replace("{DATE}", day.isoformat())
    return base


def _fetch_html_for_day(day: date) -> str:
    url = _build_url_for_day(day)
    resp = requests.get(url, timeout=15)
    resp.raise_for_status()
    return resp.text


def _parse_jq_flights(html: str, day: date):
    """Parse the public schedule HTML and extract JQ flights for the given day."""

    soup = BeautifulSoup(html, "html.parser")
    flights = []

    for row in soup.select("tr"):
        airline_el = row.select_one(".airline, .flight-airline, td:nth-child(1)")
        flight_no_el = row.select_one(".flight-number, td:nth-child(2)")

        if not flight_no_el:
            continue

        flight_no_text = flight_no_el.get_text(strip=True)
        if not flight_no_text.startswith(AIRLINE_CODE):
            if airline_el:
                airline_text = airline_el.get_text(strip=True)
                if airline_text != AIRLINE_CODE:
                    continue
            else:
                continue

        dest_el = row.select_one(".destination, .flight-destination, td:nth-child(3)")
        time_el = row.select_one(".time, .departure-time, td:nth-child(4)")
        status_el = row.select_one(".status, .flight-status, td:nth-child(5)")

        destination = dest_el.get_text(strip=True) if dest_el else None
        time_str = time_el.get_text(strip=True) if time_el else None
        status = status_el.get_text(strip=True) if status_el else None

        if not time_str:
            continue

        try:
            dep_time = datetime.strptime(time_str, "%H:%M").time()
        except ValueError:
            continue

        flights.append(
            {
                "airline_code": AIRLINE_CODE,
                "flight_number": flight_no_text,
                "date": day,
                "origin": None,
                "destination": destination,
                "departure_time": dep_time,
                "status": status,
            }
        )

    return flights


def _upsert_flights_for_day(day: date, flights: list[dict]) -> int:
    """Placeholder upsert hook; wire to ORM when available."""

    # TODO: integrate with the real CodeCrafter2 database layer.
    return len(flights)


def run_jq_live_import():
    """Import JQ flights for today + next N days and return a summary."""

    days_to_fetch = int(os.getenv("JQ_SCHEDULE_DAYS", "3"))
    base_day = _get_today_in_tz()
    results = []

    for offset in range(days_to_fetch):
        day = base_day + timedelta(days=offset)
        summary = {
            "date": day.isoformat(),
            "found": 0,
            "upserted": 0,
            "ok": False,
            "error": None,
        }
        try:
            html = _fetch_html_for_day(day)
            parsed = _parse_jq_flights(html, day)
            summary["found"] = len(parsed)
            summary["upserted"] = _upsert_flights_for_day(day, parsed)
            summary["ok"] = True
        except Exception as exc:  # noqa: BLE001
            summary["error"] = str(exc)

        results.append(summary)

    return {"days": results}
