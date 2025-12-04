"""Flask API for fetching and matching airline flights by day.

This app focuses on exposing a simple backend endpoint that Brain can
call to retrieve Jetstar (JQ) flights for Today/Tomorrow/Day after
tomorrow. It relies on the scraper and flight matcher utilities to
collect data, deduplicate it by registration, and return clean JSON for
Schedule and Machine Room use.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta
from typing import Iterable

import requests
from flask import Flask, jsonify, request

from flight_matcher import filter_flights_by_prefix, match_flights_by_rego
from scraper import get_flight_details

app = Flask(__name__)

SUPPORTED_AIRLINES = {"JQ"}
DEFAULT_AIRLINE = "JQ"
ALLOWED_DAY_OFFSETS = {0, 1, 2}
CODECRAFTER_BASE = os.environ.get("CODECRAFTER_BASE", "https://codecrafter2.onrender.com")


class FlightFetchError(RuntimeError):
    """Raised when flight data cannot be retrieved from the upstream source."""


def clamp_day_offset(raw_offset: str | int | None) -> int:
    """Parse and clamp the dayOffset query parameter into the allowed range."""

    try:
        value = int(raw_offset)
    except (TypeError, ValueError):
        return 0

    if value in ALLOWED_DAY_OFFSETS:
        return value

    return 0 if value < 0 else 2


def resolve_airline(raw_airline: str | None) -> str:
    """Return an uppercase airline code, defaulting to the supported one."""

    if not raw_airline:
        return DEFAULT_AIRLINE

    code = raw_airline.strip().upper()
    return code if code in SUPPORTED_AIRLINES else DEFAULT_AIRLINE


def build_source_urls(airline: str, target_date: date) -> list[str]:
    """Construct upstream URLs for the selected airline and date.

    The default implementation uses a template that can be overridden via
    the ``FLIGHT_SOURCE_URL_TEMPLATE`` environment variable, e.g.::

        https://example.com/direct-view?airline={airline}&date={date}&movement=departures

    Returning a list keeps the function extensible in case we need to
    combine arrivals and departures later.
    """

    template = os.getenv(
        "FLIGHT_SOURCE_URL_TEMPLATE",
        "https://www.infosyd.com/direct-view?airline={airline}&date={date}",
    )

    url = template.format(airline=airline, date=target_date.isoformat())
    return [url]


def fetch_flights(urls: Iterable[str], airline: str) -> list[dict]:
    """Fetch and combine flights from the given URLs, filtering by airline."""

    collected: list[dict] = []
    for url in urls:
        try:
            flights = get_flight_details(url, airline_prefixes=[airline])
            collected.extend(flights)
        except requests.RequestException as exc:  # noqa: PERF203
            raise FlightFetchError(f"Failed to fetch flights from {url}: {exc}") from exc

    filtered = filter_flights_by_prefix(collected, airline)
    return match_flights_by_rego(filtered)


@app.get("/api/flight-info")
def flight_info():
    """Return matched flights for the requested airline and day offset."""

    airline = resolve_airline(request.args.get("airline", DEFAULT_AIRLINE))
    day_offset = clamp_day_offset(request.args.get("dayOffset", 0))
    target_date = date.today() + timedelta(days=day_offset)

    source_urls = build_source_urls(airline, target_date)

    try:
        flights = fetch_flights(source_urls, airline)
    except FlightFetchError as exc:
        return jsonify({"error": str(exc)}), 503

    response = {
        "airline": airline,
        "dayOffset": day_offset,
        "date": target_date.isoformat(),
        "count": len(flights),
        "flights": flights,
        "generated_at": datetime.utcnow().isoformat() + "Z",
    }
    return jsonify(response)


@app.post("/api/import/jq_live")
def proxy_import_jq_live():
    """Proxy JQ live import to CodeCrafter2."""

    try:
        resp = requests.post(f"{CODECRAFTER_BASE.rstrip('/')}/api/import/jq_live", timeout=60)
    except requests.RequestException as exc:  # noqa: PERF203
        return (
            jsonify({"ok": False, "error": f"Failed to reach scheduling backend: {exc}"}),
            502,
        )

    try:
        payload = resp.json()
    except ValueError:
        return jsonify({"ok": False, "error": "Invalid response from scheduling backend"}), 502

    return jsonify(payload), resp.status_code


@app.get("/")
def healthcheck():
    """Simple health endpoint to verify the service is running."""

    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=False)
