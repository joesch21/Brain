// src/lib/opsDefaults.js
// EWOT: Centralizes explicit ops defaults (airport/airline/shift) so UI requests are always contract-safe.

function envUpper(name, fallback) {
  try {
    const raw = (import.meta?.env?.[name] ?? "").toString().trim();
    const value = raw.length > 0 ? raw : fallback;
    return String(value).toUpperCase();
  } catch {
    return String(fallback).toUpperCase();
  }
}

function envFlag(name, fallback = false) {
  try {
    const raw = (import.meta?.env?.[name] ?? "").toString().trim().toLowerCase();
    if (!raw) return Boolean(fallback);
    return ["1", "true", "yes", "on"].includes(raw);
  } catch {
    return Boolean(fallback);
  }
}

// Airport is required everywhere. Keep it explicit, never inferred.
export const REQUIRED_AIRPORT = envUpper("VITE_REQUIRED_AIRPORT", "YSSY");

// Airline + shift default to ALL unless explicitly overridden.
export const DEFAULT_AIRLINE = envUpper(
  "VITE_DEFAULT_AIRLINE",
  envUpper("VITE_DEFAULT_OPERATOR", "ALL")
);
export const DEFAULT_OPERATOR = DEFAULT_AIRLINE;
export const DEFAULT_SHIFT = envUpper("VITE_DEFAULT_SHIFT", "ALL");

// Feature flags (set to "1"/"true" to enable optional endpoints).
export const ENABLE_ROSTER = envFlag("VITE_ENABLE_ROSTER", false);
export const ENABLE_STAFF_RUNS = envFlag("VITE_ENABLE_STAFF_RUNS", false);

export function normalizeAirline(airline) {
  const v = String(airline ?? DEFAULT_AIRLINE).trim().toUpperCase();
  return v === "ALL" || v === "ALL " ? "ALL" : v;
}

export function normalizeOperator(op) {
  return normalizeAirline(op);
}

export function normalizeShift(shift) {
  const v = String(shift ?? DEFAULT_SHIFT).trim().toUpperCase();
  return v === "AM" || v === "PM" || v === "ALL" ? v : "ALL";
}
