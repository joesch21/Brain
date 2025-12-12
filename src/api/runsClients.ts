// src/api/runsClients.ts
// EWOT: Small client for fetching runs + triggering auto-assign from the Runs page.

import { API_BASE } from "./apiBase";

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Runs ${res.status} – ${
        res.statusText || "OpsAPIError"
      }: ${text}`,
    );
  }
  return (await res.json()) as T;
}

export async function fetchRunsForDate(date: string, operator: string) {
  const url = new URL(`${API_BASE}/runs/daily`);
  url.searchParams.set("date", date);
  url.searchParams.set("operator", operator);
  const res = await fetch(url.toString());
  return handleJson<any>(res);
}

export async function autoAssignRuns(date: string, operator: string) {
  const res = await fetch(`${API_BASE}/runs/auto_assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, operator }),
  });
  return handleJson<any>(res);
}
