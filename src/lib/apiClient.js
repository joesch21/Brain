// Centralized API client for Brain frontend
// Uses VITE_OPS_API_BASE (or same-origin) and normalizes errors for schedule/planner flows.
import { OPS_API_BASE } from "./opsApiBase";
import {
  ENABLE_ROSTER,
  ENABLE_STAFF_RUNS,
  REQUIRED_AIRPORT,
  normalizeOperator,
} from "./opsDefaults";
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

export async function fetchFlights(
  date,
  operator = "ALL",
  airport = REQUIRED_AIRPORT,
  options = {}
) {
  if (!date) {
    throw new Error("fetchFlights: date is required");
  }

  const qs = new URLSearchParams();
  qs.set("date", date);
  qs.set("airport", String(airport).toUpperCase());
  qs.set("operator", normalizeOperator(operator));
  return request(`/api/flights?${qs.toString()}`, options);
}

export async function getFlights({ date, airport, airline = "ALL", signal } = {}) {
  return fetchFlights(date, airline, airport, { signal });
}

export async function pullFlights(date, airline = "ALL", options = {}) {
  if (!date) {
    throw new Error("pullFlights: date is required");
  }
  if (!options.airport) {
    throw new Error("pullFlights: airport is required");
  }

  const timeoutMs = options.timeoutMs ?? 60000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  const body = {
    date,
    airport: options.airport,
    airline: airline || "ALL",
    store: true,
    timeout: 30,
    scope: "both",
  };

  try {
    return await request("/api/flights/pull", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
      body: JSON.stringify(body),
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
    if (options.signal) {
      options.signal.removeEventListener("abort", forwardAbort);
    }
  }
}

export async function fetchRuns(date, airline = "JQ", options = {}) {
  if (!date) {
    throw new Error("fetchRuns: date is required");
  }
  if (!options.airport) {
    throw new Error("fetchRuns: airport is required");
  }

  const qs = new URLSearchParams();
  qs.set("date", date);
  qs.set("airport", options.airport);
  if (airline) qs.set("airline", airline);
  return request(`/api/runs${qs.toString() ? `?${qs.toString()}` : ""}`, options);
}

export async function fetchStaffRuns(date, airline = "JQ", options = {}) {
  if (!ENABLE_STAFF_RUNS) {
    const airport = options.airport || REQUIRED_AIRPORT;
    return Promise.resolve({
      status: 200,
      data: {
        ok: true,
        available: false,
        date,
        airport,
        airline,
        runs: [],
        unassigned: [],
      },
    });
  }
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (airline) qs.set("airline", airline);
  qs.set("airport", options.airport || REQUIRED_AIRPORT);
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
  if (!ENABLE_ROSTER) {
    const airport = options.airport || REQUIRED_AIRPORT;
    return Promise.resolve({
      status: 200,
      data: {
        ok: true,
        available: false,
        date,
        airport,
        roster: { shifts: [] },
      },
    });
  }
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  qs.set("airport", options.airport || REQUIRED_AIRPORT);
  return request(
    `/api/roster/daily${qs.toString() ? `?${qs.toString()}` : ""}`,
    options
  );
}

export async function fetchStaff(options = {}) {
  const qs = new URLSearchParams();
  qs.set("airport", options.airport || REQUIRED_AIRPORT);
  if (options.date) qs.set("date", options.date);
  const operator = options.operator || options.airline;
  if (operator) qs.set("operator", operator);
  return safeRequest(`/api/staff${qs.toString() ? `?${qs.toString()}` : ""}`, {
    ...options,
    method: "GET",
  });
}

export async function fetchEmployeeAssignments(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  // STRICT CONTRACT: always send airport
  qs.set("airport", options.airport || DEFAULT_AIRPORT);
  const airline = options.airline || options.operator;
  if (airline) qs.set("airline", airline);
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
  airlineOrParams = "ALL",
  options = {}
) {
  let airline = "ALL";
  let airport;
  let shift = "ALL";

  if (airlineOrParams && typeof airlineOrParams === "object") {
    airline = airlineOrParams.airline ?? airlineOrParams.operator ?? "ALL";
    airport = airlineOrParams.airport;
    shift = airlineOrParams.shift ?? "ALL";
  } else {
    airline = airlineOrParams;
  }

  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  // STRICT CONTRACT: always send airport
  qs.set("airport", airport || options.airport || DEFAULT_AIRPORT);
  if (airline) qs.set("airline", airline);
  if (shift) qs.set("shift", shift);
  return safeRequest(`/api/runs?${qs.toString()}`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      ...options.headers,
    },
    ...options,
  });
}

export async function autoAssignRuns(date, airline = "ALL", options = {}) {
  const payload = { date, airline };
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
