// src/lib/flightNormalize.js
// One sentence: Converts the API flight rows into consistent UI-ready fields (time/flight/operator/dest) so rendering + counters stay aligned.

export function pickFirst(...vals) {
  for (const v of vals) {
    if (v !== null && v !== undefined && String(v).trim() !== "") return v;
  }
  return null;
}

export function operatorFromIdent(ident) {
  if (!ident) return "UNK";
  // JQ402 -> JQ, VA816 -> VA, QF191 -> QF, NZ110 -> NZ, QLK1429 -> QLK
  const m = String(ident).match(/^[A-Z]{2,3}/i);
  return m ? m[0].toUpperCase() : "UNK";
}

export function formatLocalHHmm(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // Render in Sydney time without extra deps
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export function normalizeFlightRow(raw) {
  const ident = pickFirst(raw?.ident_iata, raw?.ident);
  const operator = pickFirst(raw?.operator, raw?.operator_code, operatorFromIdent(ident));
  const dest = pickFirst(raw?.destination, raw?.dest);
  const timeIso = pickFirst(raw?.estimated_off, raw?.scheduled_off);
  const time = formatLocalHHmm(timeIso);

  return {
    // keep raw for debugging
    raw,

    // UI-friendly core fields
    ident: ident ?? "—",
    operator: operator ?? "UNK",
    dest: dest ?? "—",
    time,              // "HH:mm" Sydney
    time_iso: timeIso, // keep for sorting

    cancelled: !!raw?.cancelled,
    airport: raw?.airport ?? raw?.origin ?? null,
    origin: raw?.origin ?? null,
    local_date: raw?.local_date ?? null,
    fa_flight_id: raw?.fa_flight_id ?? null,
  };
}

export function extractFlightsList(resp) {
  // IMPORTANT: your API returns rows:[...]
  const list =
    resp?.rows ??
    resp?.flights ??
    resp?.items ??
    resp?.data ??
    [];
  return Array.isArray(list) ? list : [];
}
