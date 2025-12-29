// Central helper to determine the base URL for ops API calls.
// Defaults to same-origin so Planner/Machine Room talk to the Brain backend,
// but can be overridden via VITE_OPS_API_BASE when needed.
const rawBase = (import.meta?.env?.VITE_OPS_API_BASE ?? "").toString().trim();
const normalizedBase = rawBase.replace(/\/+$/, "");

const defaultOrigin = typeof window !== "undefined" ? window.location.origin : "";

export const OPS_API_BASE = normalizedBase || defaultOrigin;
