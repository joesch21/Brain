// src/api/opsClient.ts
// EWOT (one sentence): small helper client that makes all the Brain UI's
// /api/ calls go to the Ops backend (CodeCrafter2) using VITE_API_BASE_URL.

// Read base URL from Vite env, with a safe default for local/dev.
// Must include the `/api` suffix and no trailing slash.
const RAW_API_BASE =
  (import.meta as any).env?.VITE_API_BASE_URL ??
  "https://codecrafter2.onrender.com/api";

// Normalise so we don't end up with double slashes when building URLs.
const API_BASE = RAW_API_BASE.replace(/\/+$/, "");

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
// Backend wiring / status
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
// Flights + imports
// ---------------------------------------------------------------------------

export async function seedDemoFlights(date: string, airline: string) {
  const url = new URL(`${API_BASE}/imports/seed_demo_flights`);
  url.searchParams.set("date", date);
  url.searchParams.set("airline", airline);
  const res = await fetch(url.toString(), { method: "POST" });
  return handleJson<any>(res);
}

// This is the one MachineRoomPage.jsx is asking for.
export async function fetchFlightsForDate(
  date: string,
  operator: string,
): Promise<any> {
  const url = new URL(`${API_BASE}/flights`);
  url.searchParams.set("date", date);
  url.searchParams.set("operator", operator);
  const res = await fetch(url.toString());
  return handleJson<any>(res);
}

// ---------------------------------------------------------------------------
// Employee assignments / roster
// ---------------------------------------------------------------------------

export async function fetchEmployeeAssignmentsForDate(
  date: string,
  operator: string,
): Promise<any> {
  const url = new URL(`${API_BASE}/employee_assignments/daily`);
  url.searchParams.set("date", date);
  url.searchParams.set("operator", operator);
  const res = await fetch(url.toString());
  return handleJson<any>(res);
}

// Simple helper so the card code can combine results without exploding
// if either side is missing.
export function mergeFlightsWithAssignments(
  flights: any[] | undefined,
  assignments: any[] | undefined,
): { flights: any[]; assignments: any[] } {
  return {
    flights: flights ?? [],
    assignments: assignments ?? [],
  };
}

// ---------------------------------------------------------------------------
// Runs / auto-assign helpers (if used by other pages)
// ---------------------------------------------------------------------------

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
