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
  const flightNumber = pickFirst(
    raw?.ident_iata,
    raw?.ident,
    raw?.flight_number,
    raw?.flightNumber
  );
  const operatorCode = pickFirst(
    raw?.operator_code,
    raw?.operator,
    raw?.carrier,
    raw?.airline,
    operatorFromIdent(flightNumber || ident)
  );
  const dest = pickFirst(raw?.destination, raw?.dest);
  const timeIso = pickFirst(
    raw?.estimated_off,
    raw?.scheduled_off,
    raw?.etd,
    raw?.time_iso
  );
  const time = formatLocalHHmm(timeIso);
  const timeLocal = pickFirst(raw?.time_local, raw?.timeLocal, time);
  const flightId = raw?.id ?? raw?.fa_flight_id ?? raw?.flight_id ?? null;
  const key =
    raw?.flight_key ??
    raw?.key ??
    raw?.fa_flight_id ??
    raw?.id ??
    (flightNumber && timeIso ? `${flightNumber}|${timeIso}` : null);

  return {
    // keep raw for debugging
    raw,

    // UI-friendly core fields
    flight_key: key,
    key,
    flight_id: flightId,
    id: flightId,
    flight_number: flightNumber ?? "—",
    ident: ident ?? flightNumber ?? "—",
    operator_code: operatorCode ? String(operatorCode).toUpperCase() : "UNK",
    dest: dest ?? "—",
    time,              // "HH:mm" Sydney
    time_local: timeLocal ?? time,
    time_iso: timeIso, // keep for sorting

    cancelled: !!raw?.cancelled,
    airport: raw?.airport ?? raw?.origin ?? null,
    origin: raw?.origin ?? null,
    local_date: raw?.local_date ?? null,
    fa_flight_id: raw?.fa_flight_id ?? null,
  };
}

export function extractFlightsList(resp) {
  if (Array.isArray(resp)) return resp;
  const list =
    resp?.flights ??
    resp?.records ??
    resp?.rows ??
    resp?.items ??
    resp?.data ??
    [];
  return Array.isArray(list) ? list : [];
}
