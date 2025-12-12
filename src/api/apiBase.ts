// Central helper for determining the Brain API base URL.
// Ensures the UI always talks to the web backend (brain-lbaj) instead of the static host.

// Read from Vite env with a safe production default.
const RAW_API_BASE =
  (import.meta as any).env?.VITE_API_BASE_URL ??
  "https://brain-lbaj.onrender.com/api";

// Normalise by stripping any trailing slashes.
export const API_BASE = RAW_API_BASE.replace(/\/+$/, "");

// Convenience helper for showing the API host in the UI.
export const API_HOST = (() => {
  try {
    return new URL(API_BASE).host;
  } catch (err) {
    return API_BASE;
  }
})();
