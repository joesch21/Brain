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
  staff_label?: string | null;
  staff_initials?: string | null;
  role: string | null;
  run_id: number | null;
}

export interface AssignedFlight extends Flight {
  assigned_staff_name: string | null;
  assigned_staff_code: string | null;
  assigned_staff_label?: string | null;
  assigned_staff_initials?: string | null;
}

export interface AutoAssignedStaff {
  flight_id: number;
  flight_number: string;
  staff_id: number;
  staff_label: string;
  staff_initials: string;
}

export interface AutoAssignStaffResult {
  ok: boolean;
  date: string;
  operator: string;
  assigned: AutoAssignedStaff[];
  unassigned: { flight_id: number; flight_number: string }[];
  summary?: {
    total_flights: number;
    assigned_flights: number;
    unassigned_flights: number;
    full_time_staff: number;
    part_time_staff: number;
    reason: string;
  };
  type?: string;
  message?: string;
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

export async function autoAssignStaff(
  dateIso: string
): Promise<AutoAssignStaffResult> {
  const url = `${API_BASE}/api/staff_runs/auto_assign?date=${encodeURIComponent(
    dateIso
  )}`;
  return await handleJson<AutoAssignStaffResult>(
    await fetch(url, { method: "POST" })
  );
}

// Legacy alias; prefer autoAssignStaff()
export async function autoAssignEmployees(
  dateIso: string
): Promise<AutoAssignStaffResult> {
  return autoAssignStaff(dateIso);
}

export function mergeFlightsWithAssignments(
  flights: Flight[],
  assignments: EmployeeAssignment[]
): AssignedFlight[] {
  // EWOT: builds a map from flight_id -> latest staff assignment and merges into each flight row.
  const byFlightId = new Map<string, EmployeeAssignment>();

  for (const a of assignments) {
    const key =
      a.flight_id != null ? String(a.flight_id) : a.flight_number || a.flight_no;
    if (key != null) {
      byFlightId.set(String(key), a);
    }
  }

  return flights.map((f) => {
    const assignmentKey = String(
      f.id ?? f.flight_number ?? (f as any).flight_no ?? (f as any).flightNumber
    );
    const a = byFlightId.get(assignmentKey);
    return {
      ...f,
      assigned_staff_name: a?.staff_name ?? null,
      assigned_staff_code: a?.staff_code ?? null,
      assigned_staff_label: a?.staff_label ?? null,
      assigned_staff_initials: a?.staff_initials ?? null,
    };
  });
}
