// src/api/runsClients.ts
// EWOT: Runs API client that strictly obeys the API contract.

import { getEndpoint } from "./opsContractClient";

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Runs ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export async function fetchRunsForDate(
  date: string,
  airline: string,
  shift: string = "ALL",
) {
  const ep = await getEndpoint("runs");

  const url = new URL(`${(import.meta as any).env.VITE_API_BASE_URL}${ep.path}`);
  url.searchParams.set("date", date);
  url.searchParams.set("airline", airline);
  url.searchParams.set("airport", "YSSY");
  url.searchParams.set("shift", shift);

  const res = await fetch(url.toString(), { method: ep.method });
  return handleJson<any>(res);
}

export async function autoAssignRuns(date: string, airline: string) {
  const ep = await getEndpoint("runs_auto_assign");

  const res = await fetch(`${(import.meta as any).env.VITE_API_BASE_URL}${ep.path}`, {
    method: ep.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, airline })
  });

  return handleJson<any>(res);
}
