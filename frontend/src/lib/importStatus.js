import { apiUrl } from "./apiBase";

export const IMPORT_STATUS_ENDPOINT = apiUrl("api/ops/import_status");

/**
 * Fetches the import status from the backend.
 * Throws an error when the endpoint is missing, offline, or returns non-JSON.
 */
export async function fetchImportStatus() {
  try {
    const resp = await fetch(IMPORT_STATUS_ENDPOINT);
    const rawText = await resp.text();

    let parsed;
    if (rawText) {
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        throw new Error(
          "System status unavailable (backend endpoint missing or offline)."
        );
      }
    }

    if (!resp.ok) {
      const message =
        (parsed && parsed.error) ||
        rawText ||
        "Failed to load import status";
      throw new Error(message);
    }

    if (!parsed || typeof parsed !== "object") {
      throw new Error(
        "System status unavailable (backend endpoint missing or offline)."
      );
    }

    return parsed;
  } catch (err) {
    throw new Error(
      err?.message || "System status unavailable (backend endpoint missing or offline)."
    );
  }
}
