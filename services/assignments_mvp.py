"""Minimal staff assignment MVP helpers."""
from __future__ import annotations

from typing import Any, Dict, Iterable, List


def _normalize_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _first_text(flight: Dict[str, Any], keys: Iterable[str]) -> str:
    for key in keys:
        text = _normalize_text(flight.get(key))
        if text:
            return text
    return ""


def _extract_flight_number(flight: Dict[str, Any]) -> str:
    return _first_text(
        flight,
        (
            "flight_number",
            "flightNumber",
            "ident_iata",
            "ident",
            "flightNo",
        ),
    ) or "UNKNOWN"


def _extract_time_local(flight: Dict[str, Any]) -> str:
    return _first_text(
        flight,
        (
            "time_local",
            "timeLocal",
            "time_iso",
            "time",
            "scheduled_off",
            "estimated_off",
        ),
    ) or "UNKNOWN"


def build_assignments(
    flights: List[Dict[str, Any]],
    staff: List[Dict[str, Any]],
    shift: str,
) -> List[Dict[str, Any]]:
    """Build deterministic round-robin assignments for flights and staff."""
    if not flights or not staff:
        return []

    sorted_flights = sorted(
        flights,
        key=lambda flight: (
            _extract_time_local(flight),
            _extract_flight_number(flight),
        ),
    )
    sorted_staff = sorted(
        staff,
        key=lambda entry: _normalize_text(entry.get("staff_code")).upper(),
    )

    assignments: List[Dict[str, Any]] = []
    for idx, flight in enumerate(sorted_flights):
        staff_entry = sorted_staff[idx % len(sorted_staff)]
        flight_number = _extract_flight_number(flight)
        time_local = _extract_time_local(flight)
        assignments.append(
            {
                "flight_key": f"{flight_number}-{time_local}",
                "flight_number": flight_number,
                "time_local": time_local,
                "assigned_staff_id": staff_entry.get("staff_id"),
                "assigned_staff_code": staff_entry.get("staff_code"),
                "assigned_staff_name": staff_entry.get("staff_name"),
            }
        )

    return assignments
