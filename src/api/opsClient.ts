// src/api/opsClient.ts
// EWOT: Small client for talking to the Ops API (CodeCrafter2) from the Brain UI.

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

// --- Public helpers -------------------------------------------------------

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
