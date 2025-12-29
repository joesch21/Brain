export function getApiBase() {
  const raw = (
    import.meta?.env?.VITE_BRAIN_API_BASE ||
    import.meta?.env?.VITE_API_BASE ||
    import.meta?.env?.VITE_API_BASE_URL ||
    ""
  )
    .toString()
    .trim();

  if (!raw) {
    if (import.meta?.env?.PROD) {
      throw new Error(
        "Missing VITE_BRAIN_API_BASE (or VITE_API_BASE) for Brain API base in production."
      );
    }
    return "/api";
  }

  return raw.replace(/\/+$/, "");
}

export function joinApi(path) {
  const base = getApiBase();
  const p = String(path || "");

  if (!p) return base;
  if (p.startsWith("http://") || p.startsWith("https://")) return p;

  const normalizedPath = p.startsWith("/") ? p : `/${p}`;
  const baseEndsWithApi = /\/api$/i.test(base);
  const pathStartsWithApi = /^\/api(\/|$)/i.test(normalizedPath);

  if (baseEndsWithApi && pathStartsWithApi) {
    return `${base}${normalizedPath.replace(/^\/api/i, "")}`;
  }

  return `${base}${normalizedPath}`;
}
