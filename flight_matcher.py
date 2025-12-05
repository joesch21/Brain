"""Helpers for filtering and matching flights by registration.

This module keeps the registration-based matching logic that the Brain
Schedule and Machine Room expect while removing any hard-coded airline
assumptions. It works alongside the scraper, which already supports
prefix filtering, to deduplicate flights and provide a stable structure
for downstream consumers.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Iterable, List, MutableMapping


def filter_flights_by_prefix(flights: Iterable[MutableMapping], prefix: str) -> list[MutableMapping]:
    """Return only flights whose number starts with the given prefix.

    Args:
        flights: Iterable of flight dictionaries that include ``flight_number``.
        prefix: Airline prefix, e.g. "JQ".
    """

    normalized_prefix = prefix.upper().strip()
    return [
        flight
        for flight in flights
        if str(flight.get("flight_number", "")).strip().upper().startswith(normalized_prefix)
    ]


def match_flights_by_rego(flights: Iterable[MutableMapping]) -> List[MutableMapping]:
    """Match and deduplicate flights using their aircraft registration.

    The infosyd table occasionally lists the same registration multiple
    times for related movements. Downstream logic only needs one record
    per rego, so we collapse duplicates while preserving the most
    complete information we have.
    """

    by_rego: defaultdict[str, MutableMapping] = defaultdict(dict)

    for flight in flights:
        rego = str(flight.get("rego", "")).strip()
        if not rego:
            # Skip entries without a usable registration identifier.
            continue

        existing = by_rego.get(rego)
        if not existing:
            by_rego[rego] = dict(flight)
            continue

        # Merge fields, preferring non-empty values.
        for key, value in flight.items():
            if not existing.get(key) and value:
                existing[key] = value

    return list(by_rego.values())


__all__ = ["filter_flights_by_prefix", "match_flights_by_rego"]
