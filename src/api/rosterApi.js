// EWOT: Fetches the roster for a date and returns the unique operator codes on duty that day.

export async function fetchRosterOperators(date) {
  const params = new URLSearchParams({ date });

  // Adjust this path if the roster endpoint differs.
  const res = await fetch(`/api/employee_assignments/daily?${params.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`Roster HTTP ${res.status}`);
  }

  const data = await res.json();

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
