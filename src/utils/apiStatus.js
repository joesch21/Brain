import { joinApi } from "../config/apiBase";

export async function fetchApiStatus(url, options = {}) {
  try {
    const response = await fetch(joinApi(url), options);
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
      // If parsing fails, fall back to empty body so we still surface status.
      body = undefined;
    }

    if (response.ok && (typeof body !== "object" || body?.ok !== false)) {
      return { ok: true, status, data: body, url };
    }

    const derivedError = (() => {
      if (body && typeof body === "object" && body.error) return body.error;
      if (typeof body === "string" && body.trim()) return body.trim();
      if (status >= 500) return "upstream scheduling backend unavailable";
      return "Request failed";
    })();

    return {
      ok: false,
      status,
      data: body,
      error: derivedError,
      url,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.message || "Network error",
      url,
    };
  }
}

export function formatApiError(label, result) {
  if (!result) return label;
  const statusLabel = result.status === 0 ? "network" : result.status;
  const message = result.error || "Unknown error";
  const endpoint = result.url || "unknown endpoint";
  return `${label} ${statusLabel} @ ${endpoint} – ${message}`;
}
