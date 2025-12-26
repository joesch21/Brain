// src/api/apiClient.js
// Centralized API client for Brain frontend.
// - Works with Vite proxy (same-origin "/api/*") OR direct backend base.
// - Eliminates "/api/api" drift even if OPS_API_BASE includes "/api".
// - Normalizes operator/airport usage across planner/schedule/staff flows.
// - Provides two modes: "throw" (strict) and "safe" (non-throwing).

import { OPS_API_BASE } from "./opsApiBase";
import { REQUIRED_AIRPORT, normalizeOperator } from "./opsDefaults";
import { pushBackendDebugEntry } from "./backendDebug";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Normalize base + path so we never generate .../api/api/...
 * Rules:
 * - base can be "" (same-origin), "http://host:5055", or "http://host:5055/api"
 * - path can be "/api/contract" or "api/contract" etc
 * - Output should contain exactly one "/api" segment when path begins with /api
 */
function buildUrl(path) {
  const baseRaw = (OPS_API_BASE ?? "").toString().trim();

  // Already absolute?
  if (/^https?:\/\//i.test(path)) return path;

  const base = baseRaw.replace(/\/+$/, ""); // trim trailing slash
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  // If base is empty, keep same-origin relative path (Vite proxy will handle /api/*)
  if (!base) return normalizedPath;

  // If base ends with "/api" and path begins with "/api/", drop one of them
  const baseEndsWithApi = /\/api$/i.test(base);
  const pathStartsWithApi = /^\/api\//i.test(normalizedPath);

  if (baseEndsWithApi && pathStartsWithApi) {
    return `${base}${normalizedPath.replace(/^\/api/i, "")}`;
  }

  return `${base}${normalizedPath}`;
}

function parseErrorMessage(body, statusText, networkError) {
  // prefer structured backend errors
  if (body && typeof body === "object") {
    if (typeof body.error === "string") return body.error;
    if (body.error && typeof body.error === "object" && body.error.message)
      return body.error.message;
    if (body.message) return body.message;
  }

  // fall back to plain text body
  if (typeof body === "string" && body.trim()) return body;

  // network errors / status text
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
 * Core fetch wrapper.
 * mode:
 *  - "throw": throws Error on non-ok
 *  - "safe" : never throws; returns normalized result
 */
async function brainFetch(path, options = {}, mode = "throw") {
  const url = buildUrl(path);
  const method = (options.method || "GET").toUpperCase();

  const headers = {
    Accept: "application/json",
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...options.headers,
  };

  const credentials = options.credentials ?? "include";

  // Optional timeout
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // Link external abort
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

      // Log something actionable (not just "Object")
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

    if (mode === "safe") {
      return normalizeResult({ ok: true, status, statusText, url, method, body });
    }

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

/** Convenience wrappers */
function request(path, options = {}) {
  return brainFetch(path, options, "throw");
}
function safeRequest(path, options = {}) {
  return brainFetch(path, options, "safe");
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

export async function fetchFlights(date, operator = "ALL", airport = REQUIRED_AIRPORT, options = {}) {
  if (!date) throw new Error("fetchFlights: date is required");

  const qs = new URLSearchParams();
  qs.set("date", date);
  qs.set("airport", String(airport || REQUIRED_AIRPORT).toUpperCase());
  qs.set("operator", normalizeOperator(operator));
  return request(`/api/flights?${qs.toString()}`, options);
}

// Friendly alias used by some components
export async function getFlights({ date, airport, operator = "ALL", signal } = {}) {
  return fetchFlights(date, operator, airport, { signal });
}

export async function pullFlights(date, operator = "ALL", options = {}) {
  if (!date) throw new Error("pullFlights: date is required");
  if (!options.airport) throw new Error("pullFlights: airport is required");

  const body = {
    date,
    airport: options.airport,
    operator: normalizeOperator(operator), // contract-friendly
    store: true,
    timeout: 30,
    scope: "both",
  };

  return request("/api/flights/pull", {
    method: "POST",
    body: JSON.stringify(body),
    timeoutMs: options.timeoutMs ?? 60_000,
    ...options,
  });
}

export async function fetchRuns(date, operator = "ALL", options = {}) {
  if (!date) throw new Error("fetchRuns: date is required");

  const airport = options.airport || REQUIRED_AIRPORT;
  if (!airport) throw new Error("fetchRuns: airport is required");

  const qs = new URLSearchParams();
  qs.set("date", date);
  qs.set("airport", String(airport).toUpperCase());

  // Canonical: operator
  qs.set("operator", normalizeOperator(operator));

  // OPTIONAL COMPAT: if backend still expects airline, uncomment next line:
  // qs.set("airline", normalizeOperator(operator));

  if (options.shift) qs.set("shift", options.shift);

  return safeRequest(`/api/runs?${qs.toString()}`, { method: "GET", ...options });
}

export async function fetchRunsStatus(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/runs_status${suffix}`, options);
}

export async function fetchStaff(options = {}) {
  const qs = new URLSearchParams();
  const airport = options.airport || REQUIRED_AIRPORT;
  qs.set("airport", String(airport).toUpperCase());
  if (options.date) qs.set("date", options.date);

  const operator = options.operator || options.airline;
  if (operator) qs.set("operator", normalizeOperator(operator));

  return safeRequest(`/api/staff?${qs.toString()}`, { method: "GET", ...options });
}

export async function fetchEmployeeAssignments(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);

  const airport = options.airport || REQUIRED_AIRPORT;
  qs.set("airport", String(airport).toUpperCase());

  const operator = options.operator || options.airline;
  if (operator) qs.set("operator", normalizeOperator(operator));

  return request(`/api/employee_assignments/daily?${qs.toString()}`, options);
}

export async function seedDemoDay(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/dev/seed_demo_day${suffix}`, { method: "POST", ...options });
}

export async function fetchWiringStatus(options = {}) {
  return safeRequest("/api/wiring-status", { method: "GET", ...options });
}

export async function autoAssignRuns(date, operator = "ALL", options = {}) {
  const payload = {
    date,
    operator: normalizeOperator(operator),
  };
  return safeRequest("/api/runs/auto_assign", {
    method: "POST",
    body: JSON.stringify(payload),
    ...options,
  });
}

// Backward compatible export if anything imports apiRequest
export { request as apiRequest };
