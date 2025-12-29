// src/lib/staffMvp.js
// EWOT: Placeholder staff roster + deterministic assignment overlay for staff MVP.

import { operatorFromIdent } from "./flightNormalize";

const DEFAULT_ROSTER = [
  {
    staff_id: 1001,
    staff_code: "STAFF01",
    staff_name: "Dev Staff 01",
    employment_type: "FT",
    start_local: "05:00",
    end_local: "13:00",
  },
  {
    staff_id: 1002,
    staff_code: "STAFF02",
    staff_name: "Dev Staff 02",
    employment_type: "FT",
    start_local: "06:00",
    end_local: "14:00",
  },
  {
    staff_id: 1003,
    staff_code: "STAFF03",
    staff_name: "Dev Staff 03",
    employment_type: "PT",
    start_local: "07:00",
    end_local: "12:00",
  },
  {
    staff_id: 1004,
    staff_code: "STAFF04",
    staff_name: "Dev Staff 04",
    employment_type: "FT",
    start_local: "12:00",
    end_local: "20:00",
  },
  {
    staff_id: 1005,
    staff_code: "STAFF05",
    staff_name: "Dev Staff 05",
    employment_type: "PT",
    start_local: "14:00",
    end_local: "22:00",
  },
  {
    staff_id: 1006,
    staff_code: "STAFF06",
    staff_name: "Dev Staff 06",
    employment_type: "FT",
    start_local: "15:00",
    end_local: "23:00",
  },
];

function initialsFromName(name) {
  if (!name) return "";
  const parts = name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() || "");
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  return parts.join("");
}

export function getPlaceholderRoster(date, airport) {
  const seed = `${date || ""}-${airport || ""}`;
  const offset = seed.length % DEFAULT_ROSTER.length;
  return DEFAULT_ROSTER.map((entry, idx) => {
    const shifted = DEFAULT_ROSTER[(idx + offset) % DEFAULT_ROSTER.length];
    return { ...shifted };
  });
}

export function buildPlaceholderAssignments(flights, roster) {
  if (!Array.isArray(flights) || flights.length === 0) return [];
  const staff = Array.isArray(roster) && roster.length ? roster : DEFAULT_ROSTER;
  const sortedFlights = [...flights].sort((a, b) =>
    String(a.flight_key || a.flight_number || "")
      .localeCompare(String(b.flight_key || b.flight_number || ""))
  );

  return sortedFlights.map((flight, idx) => {
    const assigned = staff[idx % staff.length];
    return {
      flight_key: flight.flight_key || flight.key || null,
      flight_id: flight.flight_id ?? flight.id ?? null,
      flight_number: flight.flight_number || flight.ident || "—",
      dest: flight.dest || "—",
      operator_code:
        flight.operator_code || operatorFromIdent(flight.flight_number || flight.ident),
      etd_local: flight.time_local || flight.time || null,
      staff_id: assigned.staff_id,
      staff_code: assigned.staff_code,
      staff_name: assigned.staff_name,
      staff_initials: initialsFromName(assigned.staff_name),
    };
  });
}

export function buildAssignmentsByFlightKey(assignments, flights = []) {
  const map = new Map();
  const byId = new Map();
  const byNumberTime = new Map();

  flights.forEach((flight) => {
    if (!flight) return;
    const flightKey = flight.flight_key || flight.key;
    if (!flightKey) return;
    const flightId = flight.flight_id ?? flight.id ?? null;
    if (flightId != null) byId.set(String(flightId), flightKey);
    const flightNumber = flight.flight_number || flight.ident || null;
    const timeToken = flight.time_iso || flight.time_local || flight.time || null;
    if (flightNumber && timeToken) {
      byNumberTime.set(`${flightNumber}|${timeToken}`, flightKey);
    }
  });

  (assignments || []).forEach((assignment) => {
    if (!assignment) return;
    let flightKey = assignment.flight_key || assignment.key || null;
    if (!flightKey && assignment.flight_id != null) {
      flightKey = byId.get(String(assignment.flight_id)) || null;
    }
    if (!flightKey && assignment.flight_number) {
      const timeToken =
        assignment.time_iso || assignment.time_local || assignment.dep_time || null;
      if (timeToken) {
        flightKey = byNumberTime.get(`${assignment.flight_number}|${timeToken}`) || null;
      }
    }
    if (!flightKey) return;
    if (!map.has(flightKey)) map.set(flightKey, []);
    map.get(flightKey).push(assignment);
  });

  return map;
}

export function buildStaffRunsFromAssignments(assignments, roster = []) {
  const rosterById = new Map();
  roster.forEach((entry) => {
    const id = entry.staff_id || entry.staffId;
    if (id != null) rosterById.set(id, entry);
  });

  const runsByStaff = new Map();
  (assignments || []).forEach((assignment) => {
    const staffId = assignment.staff_id ?? assignment.staffId ?? null;
    const staffCode = assignment.staff_code || assignment.staffCode || "UNK";
    const staffName = assignment.staff_name || assignment.staffName || "Unknown";
    const key = staffId != null ? staffId : staffCode;
    if (!runsByStaff.has(key)) {
      const rosterEntry = staffId != null ? rosterById.get(staffId) : null;
      runsByStaff.set(key, {
        id: key,
        staff_id: staffId,
        staff_code: staffCode,
        staff_name: staffName,
        shift_start: rosterEntry?.start_local || rosterEntry?.startLocal || null,
        shift_end: rosterEntry?.end_local || rosterEntry?.endLocal || null,
        jobs: [],
      });
    }
    const run = runsByStaff.get(key);
    run.jobs.push({
      sequence: run.jobs.length,
      flight_number: assignment.flight_number || "",
      etd_local: assignment.etd_local || assignment.time_local || assignment.dep_time || "",
      dest: assignment.dest || "",
    });
  });

  return Array.from(runsByStaff.values());
}
