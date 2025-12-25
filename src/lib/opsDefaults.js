// src/lib/opsDefaults.js
// EWOT: Centralizes explicit ops defaults (airport/operator/shift) so UI requests are always contract-safe.

function envUpper(name, fallback) {
  try {
    const raw = (import.meta?.env?.[name] ?? "").toString().trim();
    const value = raw.length > 0 ? raw : fallback;
    return String(value).toUpperCase();
  } catch {
    return String(fallback).toUpperCase();
  }
}

// Airport is required everywhere. Keep it explicit, never inferred.
export const REQUIRED_AIRPORT = envUpper("VITE_REQUIRED_AIRPORT", "YSSY");

// Operator + shift default to ALL unless explicitly overridden.
export const DEFAULT_OPERATOR = envUpper("VITE_DEFAULT_OPERATOR", "ALL");
export const DEFAULT_SHIFT = envUpper("VITE_DEFAULT_SHIFT", "ALL");

export function normalizeOperator(op) {
  const v = String(op ?? DEFAULT_OPERATOR).trim().toUpperCase();
  return v === "ALL" || v === "ALL " ? "ALL" : v;
}

export function normalizeShift(shift) {
  const v = String(shift ?? DEFAULT_SHIFT).trim().toUpperCase();
  return v === "AM" || v === "PM" || v === "ALL" ? v : "ALL";
}
