/**
 * Shared JSON fetch helper for The Brain.
 *
 * Normalises network errors and non-2xx responses so pages/components
 * can display consistent status messages.
 */

export async function fetchJson(url, options = {}) {
  try {
    const resp = await fetch(url, options);
    const text = await resp.text();

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (err) {
        // Non-JSON body; leave data as null and use text in error.
      }
    }

    if (!resp.ok) {
      const errorMessage =
        (data && data.error) ||
        text ||
        `HTTP ${resp.status}`;

      return {
        ok: false,
        status: resp.status,
        error: errorMessage,
        data,
      };
    }

    return {
      ok: true,
      status: resp.status,
      error: null,
      data,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err?.message || "Network error",
      data: null,
    };
  }
}
