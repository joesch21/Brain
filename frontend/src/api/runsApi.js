import { fetchJson } from "../utils/api";
import { apiUrl } from "../lib/apiBase";

export async function fetchDailyRuns(date, airline = "ALL") {
  const params = new URLSearchParams({ date, airline, airport: "YSSY" });
  const response = await fetchJson(apiUrl(`api/runs?${params.toString()}`));

  if (!response.ok) {
    throw new Error(`Runs daily failed: ${response.error || `HTTP ${response.status}`}`);
  }

  return response.data;
}

export async function autoAssignRuns(date, airline = "ALL") {
  const body = JSON.stringify({ date, airline });
  const response = await fetchJson(apiUrl("api/runs/auto_assign"), {
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
