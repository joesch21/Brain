// src/lib/apiClient.js
// EWOT: Centralized API client for Brain frontend that always speaks `airline`,
// avoids /api/api duplication, and provides safe + strict request modes.

import { OPS_API_BASE } from "./opsApiBase";
import { REQUIRED_AIRPORT, normalizeAirline } from "./opsDefaults";
import { pushBackendDebugEntry } from "./backendDebug";

const DEFAULT_TIMEOUT_MS = 60_000;

/* ===========================
   URL helpers
   =========================== */

/**
 * EWOT: Join a base URL and a path without generating "/api/api/...".
 *
 * base examples:
 *  - "" (same-origin; Vite proxy handles /api/*)
 *  - "http://127.0.0.1:5055"
 *  - "http://127.0.0.1:5055/api"
 *
 * path examples:
 *  - "/api/flights?..."
 *  - "api/flights?..."
 */
function buildUrl(path) {
  const baseRaw = (OPS_API_BASE ?? "").toString().trim();

  // Absolute URL passed in
  if (/^https?:\/\//i.test(path)) return path;

  const base = baseRaw.replace(/\/+$/, ""); // trim trailing slashes
  const p = path.startsWith("/") ? path : `/${path}`;

  // Same-origin relative (preferred in dev with Vite proxy)
  if (!base) return p;

  const baseEndsWithApi = /\/api$/i.test(base);
  const pathStartsWithApi = /^\/api(\/|$)/i.test(p);

  // base ".../api" + path "/api/..." => drop one "/api"
  if (baseEndsWithApi && pathStartsWithApi) {
    return `${base}${p.replace(/^\/api/i, "")}`;
  }

  return `${base}${p}`;
}

/* ===========================
   Fetch helpers
   =========================== */

function parseErrorMessage(body, statusText, networkError) {
  if (body && typeof body === "object") {
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error === "object" && body.error.message)
      return body.error.message;
    if (typeof body.message === "string") return body.message;
  }
  if (typeof body === "string" && body.trim()) return body;
  return networkError || statusText || "Request failed";
}

function normalizeResult({ ok, status, statusText, url, method, body, errorType, networkError }) {
  const typeFromBody = body && typeof body === "object" ? body.type : null;
  const type = errorType || typeFromBody || null;

  return {
    ok: Boolean(ok),
    status: status ?? null,
    type,
    error: ok ? null : parseErrorMessage(body, statusText, networkError),
    data: body ?? null,
    raw: { url, method, statusText: statusText ?? null },
  };
}

async function readBody(response) {
  const contentType = response.headers?.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) return await response.json();
    return await response.text();
  } catch {
    return null;
  }
}

/**
 * EWOT: core request runner.
 * mode:
 *  - "throw": throws on non-ok
 *  - "safe" : never throws; always returns normalized result
 */
async function brainFetch(path, options = {}, mode = "throw") {
  const url = buildUrl(path);
  const method = String(options.method || "GET").toUpperCase();

  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };

  const credentials = options.credentials ?? "include";

  // Timeout
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Forward external abort
  const externalSignal = options.signal;
  const forwardAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", forwardAbort, { once: true });
  }

  try {
    const response = await fetch(url, {
      ...options,
      method,
      headers,
      credentials,
      signal: controller.signal,
    });

    const status = response.status;
    const statusText = response.statusText;
    const body = await readBody(response);

    // Some endpoints may return 200 with { ok:false }
    const ok = response.ok && !(body && typeof body === "object" && body.ok === false);

    if (!ok) {
      const debugEntry = pushBackendDebugEntry({
        type: "http-error",
        url,
        method,
        status,
        statusText,
        body,
      });

      console.error("[Backend HTTP Error]", {
        url,
        method,
        status,
        statusText,
        body,
        debugId: debugEntry?.id || debugEntry?.key || null,
      });

      const result = normalizeResult({ ok, status, statusText, url, method, body });

      if (mode === "safe") return result;

      const err = new Error(result.error || `HTTP ${status} ${statusText}`);
      err.status = status;
      err.data = body;
      err.url = url;
      err.type = result.type;
      throw err;
    }

    if (mode === "safe") return normalizeResult({ ok: true, status, statusText, url, method, body });

    return { status, data: body };
  } catch (err) {
    const aborted = err?.name === "AbortError";
    const debugEntry = pushBackendDebugEntry({
      type: aborted ? "aborted" : "network-error",
      url,
      method,
      error: err?.message || String(err),
    });

    console.error(aborted ? "[Backend Abort]" : "[Backend Network Error]", {
      url,
      method,
      error: err?.message || String(err),
      debugId: debugEntry?.id || debugEntry?.key || null,
    });

    const result = normalizeResult({
      ok: false,
      status: null,
      statusText: null,
      url,
      method,
      body: null,
      errorType: aborted ? "aborted" : "network_error",
      networkError: aborted ? "aborted" : (err?.message || "Network error"),
    });

    if (mode === "safe") return result;
    throw err;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
  }
}

function request(path, options = {}) {
  return brainFetch(path, options, "throw");
}
function safeRequest(path, options = {}) {
  return brainFetch(path, options, "safe");
}

/* ===========================
   Param helpers (airline canonical)
   =========================== */

function resolveAirport(airport) {
  return String(airport || REQUIRED_AIRPORT || "").toUpperCase();
}

/**
 * EWOT: Canonical airline chooser.
 * Accepts explicit airline OR legacy operator (read-only compatibility).
 * Always returns a normalized airline code (defaults to "ALL").
 */
function resolveAirline({ airline, operator } = {}, fallback = "ALL") {
  return normalizeAirline(airline ?? operator ?? fallback);
}

/* ===========================
   API functions
   =========================== */

export async function fetchStatus(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/status${suffix}`, options);
}

export async function fetchWiringStatus(options = {}) {
  return safeRequest("/api/wiring-status", { method: "GET", ...options });
}

export async function fetchRunsStatus(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/runs_status${suffix}`, options);
}

/** Flights */
export async function fetchFlights(date, airline = "ALL", airport = REQUIRED_AIRPORT, options = {}) {
  if (!date) throw new Error("fetchFlights: date is required");

  const qs = new URLSearchParams();
  qs.set("date", date);
  qs.set("airport", resolveAirport(airport));
  qs.set("airline", resolveAirline(options, airline));
  return request(`/api/flights?${qs.toString()}`, options);
}

// Friendly alias used by some components
export async function getFlights({ date, airport, airline = "ALL", operator, signal, ...rest } = {}) {
  return fetchFlights(date, operator ?? airline, airport, { signal, ...rest });
}

/** Pull flights (POST) */
export async function pullFlights(date, airline = "ALL", options = {}) {
  if (!date) throw new Error("pullFlights: date is required");
  if (!options.airport) throw new Error("pullFlights: airport is required");

  const body = {
    date,
    airport: resolveAirport(options.airport),
    airline: resolveAirline(options, airline),
    store: true,
    timeout: 30,
    scope: "both",
  };

  return request("/api/flights/pull", {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...options,
  });
}

/** Runs */
export async function fetchRuns(date, airline = "ALL", options = {}) {
  if (!date) throw new Error("fetchRuns: date is required");

  const airport = resolveAirport(options.airport);
  if (!airport) throw new Error("fetchRuns: airport is required");

  const qs = new URLSearchParams();
  qs.set("date", date);
  qs.set("airport", airport);
  qs.set("airline", resolveAirline(options, airline));
  if (options.shift) qs.set("shift", String(options.shift).toUpperCase());

  // Runs should not crash pages; return safe result
  return safeRequest(`/api/runs?${qs.toString()}`, { method: "GET", ...options });
}

/** Back-compat: older pages import fetchDailyRuns */
export async function fetchDailyRuns(date, airline = "ALL", options = {}) {
  return fetchRuns(date, airline, options);
}

/** Staff list (optional) */
export async function fetchStaff(options = {}) {
  const qs = new URLSearchParams();
  const airport = resolveAirport(options.airport);
  if (airport) qs.set("airport", airport);
  if (options.date) qs.set("date", options.date);
  if (options.shift) qs.set("shift", String(options.shift).toUpperCase());

  const airline = resolveAirline(options, "ALL");
  if (airline) qs.set("airline", airline);

  return safeRequest(`/api/staff?${qs.toString()}`, { method: "GET", ...options });
}

/** Assignments overlay (optional) */
export async function fetchAssignments(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);

  const airport = resolveAirport(options.airport);
  if (airport) qs.set("airport", airport);

  const airline = resolveAirline(options, "ALL");
  if (airline) qs.set("airline", airline);

  if (options.shift) qs.set("shift", String(options.shift).toUpperCase());

  return safeRequest(`/api/assignments?${qs.toString()}`, { method: "GET", ...options });
}

// Back-compat alias (some components still call this)
export async function fetchEmployeeAssignments(date, options = {}) {
  return fetchAssignments(date, options);
}

export async function seedDemoDay(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/dev/seed_demo_day${suffix}`, { method: "POST", ...options });
}

/** Runs auto-assign (optional) */
export async function autoAssignRuns(date, airline = "ALL", options = {}) {
  const payload = {
    date,
    airline: resolveAirline(options, airline),
  };

  return safeRequest("/api/runs/auto_assign", {
    method: "POST",
    body: JSON.stringify(payload),
    ...options,
  });
}

// Backward compatible export if anything imports apiRequest
export { request as apiRequest };