export function getApiBase() {
  const base = (import.meta.env.VITE_API_BASE || "").trim();
  if (!base) {
    throw new Error("VITE_API_BASE is missing at build time (Render env var).");
  }
  return base.replace(/\/+$/, "");
}

export function apiUrl(path) {
  const p = (path || "").startsWith("/") ? path : `/${path}`;
  return `${getApiBase()}${p}`;
}
