// Centralized API client for Brain frontend
// Uses VITE_OPS_API_BASE (or same-origin) and normalizes errors for schedule/planner flows.
import { OPS_API_BASE } from "./opsApiBase";

function buildUrl(path) {
  const base = OPS_API_BASE;
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalizedPath}`;
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

    if (!response.ok) {
      const errorMessage =
        (body && body.error) ||
        (typeof body === "string" && body) ||
        response.statusText ||
        "Request failed";

      window.backendDebug = {
        type: "http-error",
        timestamp: new Date().toISOString(),
        url,
        method,
        status,
        statusText: response.statusText,
        body,
      };
      console.error("[Backend HTTP Error]", window.backendDebug);

      const err = new Error(errorMessage);
      err.status = status;
      err.data = body;
      err.url = url;
      throw err;
    }

    return { status, data: body };
  } catch (err) {
    if (!err.status) {
      window.backendDebug = {
        type: "network-error",
        timestamp: new Date().toISOString(),
        url,
        method,
        error: err?.message || String(err),
      };
      console.error("[Backend Network Error]", window.backendDebug);
    }
    throw err;
  }
}

export async function fetchStatus(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  return request(`/api/status${qs.toString() ? `?${qs.toString()}` : ""}`, options);
}

export async function fetchFlights(date, operator = "all", options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  if (operator) qs.set("operator", operator);
  return request(`/api/flights?${qs.toString()}`, options);
}

export async function fetchRuns(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  return request(`/api/runs${qs.toString() ? `?${qs.toString()}` : ""}`, options);
}

export async function seedDemoDay(date, options = {}) {
  const qs = new URLSearchParams();
  if (date) qs.set("date", date);
  return request(`/api/dev/seed_demo_day${qs.toString() ? `?${qs.toString()}` : ""}`, {
    method: "POST",
    ...options,
  });
}

export { request as apiRequest };
