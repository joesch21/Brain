// src/api/opsClient.ts
// EWOT: Small client for talking to the Ops API (CodeCrafter2) from the Brain UI.

// Read base URL from Vite env, with a safe default for local/dev.
// Must include the `/api` suffix and no trailing slash.
const RAW_API_BASE =
  (import.meta as any).env?.VITE_API_BASE_URL ??
  "https://codecrafter2.onrender.com/api";

// Normalise so we don't end up with double slashes when building URLs.
const API_BASE = RAW_API_BASE.replace(/\/+$/, "");

/**
 * EWOT: common JSON handler that throws with a helpful message if the
 * response is not OK (non-2xx).
 */
async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `HTTP ${res.status} – ${res.statusText || "Ops API error"}\n${text}`,
    );
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Basic wiring / status helpers
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
// Flights + roster helpers
// ---------------------------------------------------------------------------

// Simple shapes that match what the backend returns closely enough for UI use.
export type Flight = {
  id: number;
  flight_number: string;
  destination: string;
  origin: string;
  operator_code: string | null;
  time_local: string | null;
  etd_local?: string | null;
  assigned_employee_id?: number | null;
  assigned_employee_name?: string | null;
};

export type Assignment = {
  flight_id: number;
  flight_number: string;
  dest: string;
  dep_time: string;
  staff_name: string | null;
  staff_code: string | null;
};

/**
 * EWOT: fetch all flights for a given date + airline/operator.
 */
export async function fetchFlightsForDate(
  date: string,
  airline: string,
): Promise<Flight[]> {
  const url = new URL(`${API_BASE}/flights`);
  url.searchParams.set("date", date);
  url.searchParams.set("operator", airline || "ALL");
  const res = await fetch(url.toString());
  const data = await handleJson<any>(res);
  // Backend wraps flights as { ok, flights: [...] }
  return (data?.flights ?? []) as Flight[];
}

/**
 * EWOT: fetch roster-based employee assignments for a date + airline/operator.
 */
export async function fetchEmployeeAssignmentsForDate(
  date: string,
  airline: string,
): Promise<Assignment[]> {
  const url = new URL(`${API_BASE}/employee_assignments/daily`);
  url.searchParams.set("date", date);
  url.searchParams.set("operator", airline || "ALL");
  const res = await fetch(url.toString());
  const data = await handleJson<any>(res);
  // Backend wraps assignments as { ok, assignments: [...] }
  return (data?.assignments ?? []) as Assignment[];
}

/**
 * EWOT: join flights and assignments into a single list per flight so the
 * Machine Room / cards can show who is working which sector.
 */
export function mergeFlightsWithAssignments(
  flights: Flight[],
  assignments: Assignment[],
) {
  // Index assignments by flight_number for quick lookup.
  const byFlightNumber = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const key = a.flight_number;
    if (!byFlightNumber.has(key)) {
      byFlightNumber.set(key, []);
    }
    byFlightNumber.get(key)!.push(a);
  }

  return flights.map((f) => {
    const fltAssignments = byFlightNumber.get(f.flight_number) ?? [];
    const primary = fltAssignments[0];

    return {
      flightId: f.id,
      flightNumber: f.flight_number,
      destination: f.destination,
      origin: f.origin,
      depTime: f.time_local ?? f.etd_local ?? "",
      operatorCode: f.operator_code,
      staffName: primary?.staff_name ?? null,
      staffCode: primary?.staff_code ?? null,
      assignments: fltAssignments,
    };
  });
}

// ---------------------------------------------------------------------------
// Auto-ops orchestration helpers (buttons in Machine Room)
// ---------------------------------------------------------------------------

export async function seedDemoFlights(date: string, airline: string) {
  const url = new URL(`${API_BASE}/imports/seed_demo_flights`);
  url.searchParams.set("date", date);
  url.searchParams.set("airline", airline);
  const res = await fetch(url.toString(), { method: "POST" });
  return handleJson<any>(res);
}

export async function autoAssignFlights(date: string, airline: string) {
  const res = await fetch(`${API_BASE}/runs/auto_assign_flights`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, airline }),
  });
  return handleJson<any>(res);
}

export async function autoAssignEmployees(date: string, airline: string) {
  const res = await fetch(`${API_BASE}/runs/auto_assign_employees`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, airline }),
  });
  return handleJson<any>(res);
}

export async function prepareOpsDay(date: string, airline: string) {
  const res = await fetch(`${API_BASE}/runs/prepare_ops_day`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, airline }),
  });
  return handleJson<any>(res);
}
