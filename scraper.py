"""Utilities for scraping flight details from HTML tables.

This module exposes a single helper, :func:`get_flight_details`, which fetches
an HTML page, extracts flight data from the first table, and returns a list of
records compatible with existing Brain flight handling code.
"""

from __future__ import annotations

from typing import Iterable, List, Optional

import logging

import requests
from bs4 import BeautifulSoup


logger = logging.getLogger(__name__)


def _normalize_header(value: str) -> str:
    """Return a normalized header label for lookup."""

    return value.strip().lower().replace(" ", "")


def _should_include_flight(
    flight_number: str, airline_prefixes: Optional[Iterable[str]]
) -> bool:
    """Decide whether a flight should be included based on airline prefixes."""

    if not airline_prefixes:
        return True

    prefixes = [prefix.upper() for prefix in airline_prefixes]
    return flight_number.upper().startswith(tuple(prefixes))


def _extract_cell_texts(row) -> List[str]:
    """Extract and clean text from a table row's cells."""

    return [cell.get_text(strip=True) for cell in row.find_all(["td", "th"])]


def _normalize_scheduled_time(raw: str, flight_number: str) -> Optional[str]:
    """Validate and normalize a scheduled time cell.

    Returns a cleaned ``HH:MM`` string when valid, otherwise ``None``.
    Logs a warning when the value looks malformed so imports can surface
    upstream issues.
    """

    value = raw.strip()
    if not value or value == "-":
        return None

    parts = value.split(":")
    if len(parts) != 2:
        logger.warning("[scraper] Unexpected scheduled time format for %s: %s", flight_number, raw)
        return None

    hour_part, minute_part = parts
    if not (hour_part.isdigit() and minute_part.isdigit()):
        logger.warning("[scraper] Non-numeric scheduled time for %s: %s", flight_number, raw)
        return None

    try:
        hour = int(hour_part)
        minute = int(minute_part)
    except ValueError:
        logger.warning("[scraper] Failed to parse scheduled time for %s: %s", flight_number, raw)
        return None

    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        logger.warning("[scraper] Out-of-range scheduled time for %s: %s", flight_number, raw)
        return None

    return f"{hour:02d}:{minute:02d}"


def get_flight_details(url: str, airline_prefixes: Optional[Iterable[str]] = None) -> List[dict]:
    """Fetch flight details from a table on the given page.

    Args:
        url: The URL of the HTML page containing the flight table.
        airline_prefixes: Optional iterable of airline prefixes (e.g., ["JQ"]).
            If provided, only flights whose ``flight_number`` starts with any of the
            prefixes will be included. If omitted or empty, all flights are
            returned.

    Returns:
        A list of dictionaries with keys: ``flight_number``, ``rego``, ``bay``,
        ``status``, and ``destination``.
    """

    response = requests.get(url, timeout=30)
    response.raise_for_status()

    soup = BeautifulSoup(response.content, "html.parser")
    table = soup.find("table")
    if not table:
        return []

    header_map = {}
    flights = []

    for row in table.find_all("tr"):
        cells = _extract_cell_texts(row)
        if not cells:
            continue

        # Capture header indices for later lookup.
        if row.find_all("th"):
            header_map = {_normalize_header(text): idx for idx, text in enumerate(cells)}
            continue

        flight_number_idx = header_map.get("flight") if header_map else 0
        rego_idx = header_map.get("rego") if header_map else 1
        bay_idx = header_map.get("bay") if header_map else 2
        status_idx = header_map.get("status") if header_map else 3
        destination_idx = header_map.get("destination") if header_map else 4
        scheduled_idx = header_map.get("scheduled") if header_map else None

        try:
            flight_number = cells[flight_number_idx]
        except IndexError:
            continue

        if not _should_include_flight(flight_number, airline_prefixes):
            continue

        def safe_get(index: Optional[int]) -> str:
            if index is None:
                return ""
            try:
                return cells[index]
            except IndexError:
                return ""

        scheduled_raw = safe_get(scheduled_idx)
        scheduled_time = _normalize_scheduled_time(scheduled_raw, flight_number)

        flight_info = {
            "flight_number": flight_number,
            "rego": safe_get(rego_idx),
            "bay": safe_get(bay_idx),
            "status": safe_get(status_idx),
            "destination": safe_get(destination_idx),
            "scheduled_time_str": scheduled_time,
        }
        flights.append(flight_info)

    return flights


__all__ = ["get_flight_details"]
