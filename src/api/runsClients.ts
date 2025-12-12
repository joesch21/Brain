// src/api/runsClients.ts
// EWOT: Small client for fetching runs + triggering auto-assign from the Runs page.

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
