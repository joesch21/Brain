import { getApiBase, joinApi } from "../config/apiBase";

// Central helper for determining the Brain API base URL.
// Ensures the UI always talks to the web backend instead of the static host.
export const API_BASE = joinApi("/api");

// Convenience helper for showing the API host in the UI.
export const API_HOST = (() => {
  try {
    return new URL(API_BASE).host;
  } catch (err) {
    return getApiBase();
  }
})();
