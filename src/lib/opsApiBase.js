const rawBase = (import.meta?.env?.VITE_API_BASE_URL ?? "").toString().trim();
const normalizedBase = rawBase.replace(/\/+$/, "");

const defaultOrigin = typeof window !== "undefined" ? window.location.origin : "";

export const OPS_API_BASE = normalizedBase || defaultOrigin;
