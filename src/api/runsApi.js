import { fetchJson } from "../utils/api";

export async function fetchDailyRuns(date, operator = "ALL") {
  const params = new URLSearchParams({ date, operator, airport: "YSSY" });
  const response = await fetchJson(`/api/runs?${params.toString()}`);

  if (!response.ok) {
    throw new Error(`Runs daily failed: ${response.error || `HTTP ${response.status}`}`);
  }

  return response.data;
}

export async function autoAssignRuns(date, operator = "ALL") {
  const body = JSON.stringify({ date, operator });
  const response = await fetchJson("/api/runs/auto_assign", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Auto-assign runs failed: ${response.error || `HTTP ${response.status}`}`);
  }

  return response.data;
}
