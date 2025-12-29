import {
  DEFAULT_AIRLINE,
  DEFAULT_SHIFT,
  REQUIRED_AIRPORT,
  normalizeAirline,
  normalizeShift,
} from "../lib/opsDefaults";
import { apiUrl } from "../lib/apiBase";

// EWOT: Fetches the roster for a date and returns the unique operator codes on duty that day.

export async function fetchRosterOperators(date) {
  const params = new URLSearchParams({
    date,
    airport: REQUIRED_AIRPORT,
    airline: normalizeAirline(DEFAULT_AIRLINE),
    shift: normalizeShift(DEFAULT_SHIFT),
  });

  // Adjust this path if the roster endpoint differs.
  const res = await fetch(
    apiUrl(`/api/employee_assignments/daily?${params.toString()}`),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    }
  );

  if (!res.ok) {
    return [];
  }

  const data = await res.json();
  if (data?.available === false) return [];
  if (data?.ok === false) return [];

  // Expecting something like: { assignments: [ { operator: "QF", ... }, ... ] }
  const assignments = Array.isArray(data.assignments) ? data.assignments : [];

  const uniqueOps = Array.from(
    new Set(
      assignments
        .map((a) => a.operator)
        .filter((op) => typeof op === "string" && op.trim().length > 0)
    )
  ).sort();

  return uniqueOps; // e.g. ["JQ", "QF", "VA"]
}
