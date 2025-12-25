// src/api/opsClient.ts
// EWOT: Small client for talking to the Ops API (CodeCrafter2) from the Brain UI.

export interface Flight {
  id: number;
  flight_number: string;
  destination: string;
  origin: string;
  time_local: string | null;
  operator_code: string | null;
}

export interface EmployeeAssignment {
  flight_id: number;
  flight_number: string;
  staff_id: number | null;
  staff_name: string | null;
  staff_code: string | null;
}

export interface MergedFlightAssignment extends Flight {
  assigned_staff_name: string | null;
  assigned_staff_code: string | null;
}

import { API_BASE } from "./apiBase";
import {
  DEFAULT_OPERATOR,
  DEFAULT_SHIFT,
  REQUIRED_AIRPORT,
  normalizeOperator,
  normalizeShift,
} from "../lib/opsDefaults";

async function handleJson<T>(res: Response): Promise<T> {
  let text: string | null = null;

  if (!res.ok) {
    try {
      text = await res.text();
    } catch {
      text = null;
    }

    const baseMessage = `HTTP ${res.status} – ${
      res.statusText || "Ops API error"
    }`;
    const message =
      text && text.length > 0 ? `${baseMessage}\n${text}` : baseMessage;

    throw new Error(message);
  }

  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Wiring / backend health
// ---------------------------------------------------------------------------

export async function fetchBackendStatus(date?: string) {
  const url = new URL(`${API_BASE}/status`);
  if (date) {
    url.searchParams.set("date", date);
  }
  const res = await fetch(url.toString());
  return handleJson<any>(res);
}

export async function runWiringStatus() {
  const res = await fetch(`${API_BASE}/wiring-status`);
  return handleJson<any>(res);
}

export async function fetchOpsDebugWiring() {
  const res = await fetch(`${API_BASE}/ops/debug/wiring`);
  return handleJson<any>(res);
}

// ---------------------------------------------------------------------------
// Flights + assignments + auto-assign flows
// ---------------------------------------------------------------------------

export interface FlightsResponse {
  ok: boolean;
  date: string;
  flights: Flight[];
  [key: string]: any;
}

export interface EmployeeAssignmentsResponse {
  ok: boolean;
  date: string;
  assignments: EmployeeAssignment[];
  error?: string;
  available?: boolean;
  reason?: string;
  [key: string]: any;
}

function normalizeAssignmentsToList(assignments: any): EmployeeAssignment[] {
  if (!assignments) return [];
  if (Array.isArray(assignments)) return assignments as EmployeeAssignment[];
  if (typeof assignments === "object") {
    const out: EmployeeAssignment[] = [];
    for (const v of Object.values(assignments)) {
      if (!v) continue;
      if (Array.isArray(v)) out.push(...(v as EmployeeAssignment[]));
      else if (typeof v === "object") out.push(v as EmployeeAssignment);
    }
    return out;
  }
  return [];
}

/**
 * EWOT: fetch flights for a given date and airline from the Ops API.
 */
export async function fetchFlightsForDate(
  date: string,
  operator: string = DEFAULT_OPERATOR,
  airport: string = REQUIRED_AIRPORT,
): Promise<Flight[]> {
  const url = new URL(`${API_BASE}/flights`);
  url.searchParams.set("date", date);
  url.searchParams.set("airport", String(airport).toUpperCase());
  url.searchParams.set("operator", normalizeOperator(operator));

  const res = await fetch(url.toString());
  const payload = await handleJson<FlightsResponse>(res);

  // Flights are required data; allow caller to handle errors.
  if (!payload.ok) {
    throw new Error(payload.error || "Failed to load flights from Ops API");
  }

  return payload.flights ?? [];
}

/**
 * EWOT: fetch employee assignments for a given date (and airline/operator).
 */
export async function fetchEmployeeAssignmentsForDate(
  date: string,
  opts?: { airport?: string; operator?: string; shift?: string } | string,
): Promise<EmployeeAssignment[]> {
  // Staff assignments are OPTIONAL overlay: never throw, never block renders.
  try {
    const legacyOperator = typeof opts === "string" ? opts : null;
    const airport =
      typeof opts === "object" && opts?.airport ? opts.airport : REQUIRED_AIRPORT;
    const operator =
      typeof opts === "object" && opts?.operator
        ? opts.operator
        : legacyOperator || DEFAULT_OPERATOR;
    const shift =
      typeof opts === "object" && opts?.shift ? opts.shift : DEFAULT_SHIFT;

    const url = new URL(`${API_BASE}/employee_assignments/daily`);
    url.searchParams.set("date", date);
    url.searchParams.set("airport", String(airport).toUpperCase());
    url.searchParams.set("operator", normalizeOperator(operator));
    url.searchParams.set("shift", normalizeShift(shift));

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];

    let payload: EmployeeAssignmentsResponse | null = null;
    try {
      payload = (await res.json()) as EmployeeAssignmentsResponse;
    } catch {
      return [];
    }

    if (payload?.available === false) return [];
    if (payload?.ok === false) return [];

    return normalizeAssignmentsToList((payload as any)?.assignments);
  } catch {
    return [];
  }
}

/**
 * EWOT: seed demo flights for a given date + airline in the Ops backend.
 */
export async function seedDemoFlights(date: string, airline: string) {
  const url = new URL(`${API_BASE}/imports/seed_demo_flights`);
  url.searchParams.set("date", date);
  url.searchParams.set("airline", airline);

  const res = await fetch(url.toString(), { method: "POST" });
  return handleJson<any>(res);
}

/**
 * EWOT: ask the Ops backend to auto-assign refueller runs to flights.
 */
export async function autoAssignFlights(date: string, airline: string) {
  const res = await fetch(`${API_BASE}/runs/auto_assign_flights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, airline }),
  });
  return handleJson<any>(res);
}

/**
 * EWOT: ask the Ops backend to auto-assign staff (employees) to flights.
 * This is what MachineRoomPage imports as `autoAssignStaff`.
 */
export async function autoAssignStaff(date: string, airline: string) {
  const res = await fetch(`${API_BASE}/runs/auto_assign_employees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, airline }),
  });
  return handleJson<any>(res);
}

/**
 * EWOT: end-to-end prep for the ops day (flights + runs + staff) in one call.
 */
export async function prepareOpsDay(date: string, airline: string) {
  const res = await fetch(`${API_BASE}/runs/prepare_ops_day`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, airline }),
  });
  return handleJson<any>(res);
}

/**
 * EWOT: merge flights with employee assignments so the UI can show each flight
 * together with its assigned staff code/name.
 */
export function mergeFlightsWithAssignments(
  flights: Flight[],
  assignments: EmployeeAssignment[],
): MergedFlightAssignment[] {
  const byFlightId = new Map<number, EmployeeAssignment>();

  for (const a of assignments) {
    if (a.flight_id != null) {
      byFlightId.set(a.flight_id, a);
    }
  }

  return flights.map((f) => {
    const a = byFlightId.get(f.id);
    return {
      ...f,
      assigned_staff_name: a?.staff_name ?? null,
      assigned_staff_code: a?.staff_code ?? null,
    };
  });
}
