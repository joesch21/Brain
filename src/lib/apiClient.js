// Centralized API client for Brain frontend
// Uses VITE_OPS_API_BASE (or same-origin) and normalizes errors for schedule/planner flows.
import { OPS_API_BASE } from "./opsApiBase";
import { pushBackendDebugEntry } from "./backendDebug";

const DEFAULT_AIRPORT = "YSSY";

function buildUrl(path) {
  const base = OPS_API_BASE;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
}

function normalizeResult({
  ok,
  status,
  body,
  statusText,
  url,
  method,
  errorType,
  networkError,
}) {
  const typeFromBody = body?.type;
  const type = errorType || typeFromBody || null;
  const errorMessage =
    (body?.error && typeof body.error === "object"
      ? body.error.message
      : body?.error) ||
    (typeof body === "string" ? body : null) ||
    networkError ||
    statusText;

  return {
    ok,
    status,
    type,
    error: errorMessage || null,
    data: body,
    raw: { url, method },
  };
}

async function safeRequest(path, options = {}) {
  const url = buildUrl(path);
  const method = options.method || "GET";
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  const credentials = options.credentials ?? "include";

  try {
    const response = await fetch(url, { ...options, headers, credentials });
    const status = response.status;
    const statusText = response.statusText;
    const contentType = response.headers?.get("content-type") || "";
    let body;

    try {
      if (contentType.includes("application/json")) {
        body = await response.json();
      } else {
        body = await response.text();
      }
    } catch (parseErr) {
      body = undefined;
    }

    const ok = response.ok && (body?.ok !== false);
    const type = body?.type;

    if (!ok) {
      const debugEntry = pushBackendDebugEntry({
        type: "http-error",
        url,
        method,
        status,
        statusText,
        body,
      });
      console.error("[Backend HTTP Error]", debugEntry);
    }

    return normalizeResult({
      ok,
      status,
      body,
      statusText,
      url,
      method,
      errorType: type,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      return normalizeResult({
        ok: false,
        status: null,
        body: null,
        statusText: null,
        url,
        method,
        errorType: "aborted",
        networkError: "aborted",
      });
    }
    const debugEntry = pushBackendDebugEntry({
      type: "network-error",
      url,
      method,
      error: err?.message || String(err),
    });
    console.error("[Backend Network Error]", debugEntry);

    return normalizeResult({
      ok: false,
      status: null,
      body: null,
      statusText: null,
      url,
      method,
      errorType: "network_error",
      networkError: err?.message || "Network error",
    });
  }
}

async function request(path, options = {}) {
  const url = buildUrl(path);
  const method = options.method || "GET";
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  const credentials = options.credentials ?? "include";

  try {
    const response = await fetch(url, { ...options, headers, credentials });
    const status = response.status;
    const contentType = response.headers?.get("content-type") || "";
    let body;

    try {
      if (contentType.includes("application/json")) {
        body = await response.json();
      } else {
        body = await response.text();
      }
    } catch (parseErr) {
      body = undefined;
    }

    const ok = response.ok && (body?.ok !== false);

    if (!ok) {
      const errorMessage =
        (body && body.error) ||
        (typeof body === "string" && body) ||
        response.statusText ||
        "Request failed";

      const debugEntry = pushBackendDebugEntry({
        type: "http-error",
        url,
        method,
        status,
        statusText: response.statusText,
        body,
      });
      console.error("[Backend HTTP Error]", debugEntry);

      const err = new Error(errorMessage);
      err.status = status;
      err.data = body;
      err.url = url;
      err.type = body?.type || null;
      throw err;
    }

    return { status, data: body };
  } catch (err) {
    if (err?.name === "AbortError") {
      throw err;
    }
    if (!err.status) {
      const debugEntry = pushBackendDebugEntry({
        type: "network-error",
        url,
        method,
        error: err?.message || String(err),
      });
      console.error("[Backend Network Error]", debugEntry);
    }
    throw err;
  }
}

export async function fetchStatus(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  return request(`/api/status${qs.toString() ? `?${qs.toString()}` : ""}`, options);
}

export async function fetchFlights(date, operator = "ALL", options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  // STRICT CONTRACT: always send airport
  qs.set("airport", options.airport || DEFAULT_AIRPORT);
  if (operator) qs.set("operator", operator);
  return request(`/api/flights?${qs.toString()}`, options);
}

export async function fetchRuns(date, airline = "JQ", options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  // STRICT CONTRACT: always send airport
  qs.set("airport", options.airport || DEFAULT_AIRPORT);
  if (airline) qs.set("airline", airline);
  return request(`/api/runs${qs.toString() ? `?${qs.toString()}` : ""}`, options);
}

export async function fetchStaffRuns(date, airline = "JQ", options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (airline) qs.set("airline", airline);
  return request(
    `/api/staff_runs${qs.toString() ? `?${qs.toString()}` : ""}`,
    options
  );
}

export async function fetchRunsStatus(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  return request(
    `/api/runs_status${qs.toString() ? `?${qs.toString()}` : ""}`,
    options
  );
}

export async function fetchDailyRoster(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  return request(
    `/api/roster/daily${qs.toString() ? `?${qs.toString()}` : ""}`,
    options
  );
}

export async function fetchEmployeeAssignments(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  // STRICT CONTRACT: always send airport
  qs.set("airport", options.airport || DEFAULT_AIRPORT);
  return request(
    `/api/employee_assignments/daily${qs.toString() ? `?${qs.toString()}` : ""}`,
    options
  );
}

export async function seedDemoDay(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  return request(`/api/dev/seed_demo_day${qs.toString() ? `?${qs.toString()}` : ""}`, {
    method: "POST",
    ...options,
  });
}

export async function fetchWiringStatus(options = {}) {
  return safeRequest("/api/wiring-status", {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
    ...options,
  });
}

export async function fetchDailyRuns(
  date,
  operatorOrParams = "ALL",
  options = {}
) {
  let operator = "ALL";
  let airport;
  let shift = "ALL";

  if (operatorOrParams && typeof operatorOrParams === "object") {
    operator = operatorOrParams.operator ?? "ALL";
    airport = operatorOrParams.airport;
    shift = operatorOrParams.shift ?? "ALL";
  } else {
    operator = operatorOrParams;
  }

  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  // STRICT CONTRACT: always send airport
  qs.set("airport", airport || options.airport || DEFAULT_AIRPORT);
  if (operator) qs.set("operator", operator);
  if (shift) qs.set("shift", shift);
  return safeRequest(`/api/runs/daily?${qs.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
    ...options,
  });
}

export async function autoAssignRuns(date, operator = "ALL", options = {}) {
  const payload = { date, operator };
  return safeRequest("/api/runs/auto_assign", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
    body: JSON.stringify(payload),
    ...options,
  });
}

export async function fetchStaffRunsLatest(date, airline, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (airline) qs.set("airline", airline);
  return safeRequest(`/api/staff_runs${qs.toString() ? `?${qs.toString()}` : ""}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
    ...options,
  });
}

export async function generateStaffRuns(date, airline, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (airline) qs.set("airline", airline);
  return safeRequest(`/api/staff_runs/generate${qs.toString() ? `?${qs.toString()}` : ""}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...options.headers,
    },
    body: JSON.stringify({ date, airline }),
    ...options,
  });
}

export { request as apiRequest };
