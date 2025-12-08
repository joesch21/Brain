// Simple Ops API client for flights + employee assignments + auto-assign actions.
// EWOT: wraps fetch() calls to our backend ops API.

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
  dest: string;
  dep_time: string;
  staff_name: string | null;
  staff_code: string | null;
  role: string | null;
  run_id: number | null;
}

export interface AssignedFlight extends Flight {
  assigned_staff_name: string | null;
  assigned_staff_code: string | null;
}

const API_BASE =
  import.meta.env.VITE_API_BASE_URL || "https://codecrafter2.onrender.com";

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} – ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function fetchFlightsForDate(dateIso: string): Promise<Flight[]> {
  const url = `${API_BASE}/api/flights?date=${encodeURIComponent(
    dateIso
  )}&operator=all`;
  const data = await handleJson<{ flights: Flight[] }>(await fetch(url));
  return data.flights || [];
}

export async function fetchEmployeeAssignmentsForDate(
  dateIso: string
): Promise<EmployeeAssignment[]> {
  const url = `${API_BASE}/api/employee_assignments/daily?date=${encodeURIComponent(
    dateIso
  )}`;
  const data = await handleJson<{ assignments: EmployeeAssignment[] }>(
    await fetch(url)
  );
  return data.assignments || [];
}

export async function autoAssignFlights(dateIso: string): Promise<void> {
  const url = `${API_BASE}/api/auto_assign/flights?date=${encodeURIComponent(
    dateIso
  )}`;
  await handleJson(await fetch(url, { method: "POST" }));
}

export async function autoAssignEmployees(dateIso: string): Promise<void> {
  const url = `${API_BASE}/api/auto_assign/employees?date=${encodeURIComponent(
    dateIso
  )}`;
  await handleJson(await fetch(url, { method: "POST" }));
}

export function mergeFlightsWithAssignments(
  flights: Flight[],
  assignments: EmployeeAssignment[]
): AssignedFlight[] {
  // EWOT: builds a map from flight_id -> latest staff assignment and merges into each flight row.
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
