// src/api/runsClients.ts
// EWOT: Runs API client that strictly obeys the API contract and never sends [object Object] into query params.

import { joinApi } from "../config/apiBase";
import { getEndpoint } from "./opsContractClient";

async function handleJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Runs ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * EWOT: Turn "airline selection" (string | csv | array | object) into safe query params:
 * - Always returns a safe single airline string (defaults to "ALL")
 * - Optionally returns airlinesCsv for multi-select (e.g. "JQ,QF")
 * - Never returns "[object Object]"
 */
function normalizeAirlineSelection(input: any): { airline: string; airlinesCsv?: string } {
  const toCode = (v: any): string => {
    if (v == null) return "";
    if (typeof v === "string") return v.trim().toUpperCase();

    if (typeof v === "object") {
      // Common shapes we see in UI state
      const candidate =
        v.code ??
        v.value ??
        v.airline ??
        v.operator ??
        v.operator_code ??
        v.operatorCode ??
        v.name;
      return typeof candidate === "string" ? candidate.trim().toUpperCase() : "";
    }
    return "";
  };

  // 1) CSV string case: "JQ,QF"
  if (typeof input === "string") {
    const raw = input.trim();
    if (!raw) return { airline: "ALL" };

    // If it looks like CSV, treat as multi-select
    if (raw.includes(",")) {
      const parts = raw
        .split(",")
        .map((p) => p.trim().toUpperCase())
        .filter(Boolean);

      if (parts.length === 0) return { airline: "ALL" };
      if (parts.length === 1) return { airline: parts[0] };

      return { airline: "ALL", airlinesCsv: parts.join(",") };
    }

    return { airline: raw.toUpperCase() };
  }

  // 2) Array case: ["JQ","QF"] or [{code:"JQ"},{code:"QF"}]
  if (Array.isArray(input)) {
    const parts = input.map(toCode).filter(Boolean);

    if (parts.length === 0) return { airline: "ALL" };
    if (parts.length === 1) return { airline: parts[0] };

    return { airline: "ALL", airlinesCsv: parts.join(",") };
  }

  // 3) Object case: {code:"JQ"} etc
  if (input && typeof input === "object") {
    const code = toCode(input);
    return { airline: code || "ALL" };
  }

  return { airline: "ALL" };
}

export async function fetchRunsForDate(
  date: string,
  airlineSelection: any,
  shift: string = "ALL",
) {
  const ep = await getEndpoint("runs");

  const baseOrigin =
    typeof window !== "undefined" ? window.location.origin : "http://localhost";
  const url = new URL(joinApi(ep.path), baseOrigin);

  const norm = normalizeAirlineSelection(airlineSelection);

  url.searchParams.set("date", date);
  url.searchParams.set("airport", "YSSY");
  url.searchParams.set("shift", shift);

  // Back-compat: always set airline (single string)
  url.searchParams.set("airline", norm.airline);

  // Multi-select: additionally set airlines=CSV (preferred for Brain filtering)
  if (norm.airlinesCsv) {
    url.searchParams.set("airlines", norm.airlinesCsv);
  } else {
    // Ensure we don't accidentally preserve stale airlines param
    url.searchParams.delete("airlines");
  }

  const res = await fetch(url.toString(), { method: ep.method });
  return handleJson<any>(res);
}

export async function autoAssignRuns(date: string, airlineSelection: any) {
  const ep = await getEndpoint("runs_auto_assign");

  const norm = normalizeAirlineSelection(airlineSelection);

  // NOTE: auto-assign currently only accepts one airline string in the body.
  // If multi-select was given, we send airline="ALL" to avoid breaking.
  const airline = norm.airline || "ALL";

  const res = await fetch(joinApi(ep.path), {
    method: ep.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, airline })
  });

  return handleJson<any>(res);
}
