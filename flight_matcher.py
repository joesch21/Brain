"""Helpers for filtering and matching flights by registration.

This module provides two main helpers:
- ``filter_flights_by_prefix`` to trim a mixed flight list down to a
  single airline by IATA prefix.
- ``match_flights_by_rego`` to pair arrival and departure flights that
  share the same aircraft registration.

A small manual test is available via ``python flight_matcher.py`` which
fetches direct-view data from Infosyd, filters by a hard-coded airline
prefix, and prints the matched flights.
"""

from __future__ import annotations

from typing import Dict, Iterable, List

from scraper import get_flight_details


Flight = Dict[str, str]
Match = Dict[str, str]


def filter_flights_by_prefix(flights: Iterable[Flight], airline_prefix: str) -> List[Flight]:
    """Return flights whose ``flight_number`` starts with ``airline_prefix``.

    The comparison is case-insensitive and safely handles missing flight
    numbers.
    """

    prefix = (airline_prefix or "").upper()
    if not prefix:
        return list(flights)

    return [
        flight
        for flight in flights
        if str(flight.get("flight_number", "")).upper().startswith(prefix)
    ]


def match_flights_by_rego(arrivals: Iterable[Flight], departures: Iterable[Flight]) -> List[Match]:
    """Pair arrival and departure flights by matching registration.

    Args:
        arrivals: Iterable of arrival flight dictionaries.
        departures: Iterable of departure flight dictionaries.

    Returns:
        A list of dictionaries with the following keys:
        ``arrival_flight_number``, ``departure_flight_number``, ``rego``,
        ``bay``, ``status``, ``departure_status``, ``destination``.
    """

    departures_by_rego: Dict[str, List[Flight]] = {}
    for departure in departures:
        rego = str(departure.get("rego", "")).strip().upper()
        if not rego:
            continue
        departures_by_rego.setdefault(rego, []).append(departure)

    matches: List[Match] = []
    for arrival in arrivals:
        rego = str(arrival.get("rego", "")).strip().upper()
        if not rego:
            continue

        matching_departures = departures_by_rego.get(rego)
        if not matching_departures:
            continue

        departure = matching_departures.pop(0)
        if not matching_departures:
            departures_by_rego.pop(rego, None)

        matches.append(
            {
                "arrival_flight_number": arrival.get("flight_number", ""),
                "departure_flight_number": departure.get("flight_number", ""),
                "rego": arrival.get("rego", "") or departure.get("rego", ""),
                "bay": departure.get("bay", "") or arrival.get("bay", ""),
                "status": arrival.get("status", ""),
                "departure_status": departure.get("status", ""),
                "destination": departure.get("destination", "")
                or arrival.get("destination", ""),
            }
        )

    return matches


def _manual_test() -> None:
    """Run a basic fetch + match test using hard-coded Infosyd URLs."""

    airline_prefix = "JQ"
    arrival_url = "https://www.infosyd.com/direct-view/sydney-domestic-arrivals"
    departure_url = "https://www.infosyd.com/direct-view/sydney-domestic-departures"

    print(f"Fetching arrivals for prefix {airline_prefix}…")
    try:
        arrivals = get_flight_details(arrival_url)
    except Exception as exc:  # pragma: no cover - manual test helper
        print(f"Failed to fetch arrivals: {exc}")
        arrivals = []

    print(f"Fetching departures for prefix {airline_prefix}…")
    try:
        departures = get_flight_details(departure_url)
    except Exception as exc:  # pragma: no cover - manual test helper
        print(f"Failed to fetch departures: {exc}")
        departures = []

    filtered_arrivals = filter_flights_by_prefix(arrivals, airline_prefix)
    filtered_departures = filter_flights_by_prefix(departures, airline_prefix)

    matches = match_flights_by_rego(filtered_arrivals, filtered_departures)

    if not matches:
        print("No matched flights found.")
        return

    print("Matched flights:")
    for match in matches:
        print(match)


if __name__ == "__main__":  # pragma: no cover - manual test entrypoint
    _manual_test()

