export const MAX_FLIGHTS_PER_RUN = 8;
export const MIN_GAP_MINUTES_TIGHT = 20;

function minutesBetween(t1, t2) {
  if (!t1 || !t2) return null;
  const [h1, m1] = t1.split(":").map(Number);
  const [h2, m2] = t2.split(":").map(Number);
  if (Number.isNaN(h1) || Number.isNaN(m1) || Number.isNaN(h2) || Number.isNaN(m2)) {
    return null;
  }
  const dt1 = h1 * 60 + m1;
  const dt2 = h2 * 60 + m2;
  return dt2 - dt1;
}

function getFlightId(flightEntry) {
  if (!flightEntry) return undefined;
  const flight = flightEntry.flight || {};
  return (
    flightEntry.id ??
    flightEntry.flight_run_id ??
    flightEntry.flightRunId ??
    flight.id ??
    flight.flight_id
  );
}

function getFlightTime(flightEntry) {
  if (!flightEntry) return null;
  const flight = flightEntry.flight || {};
  return (
    flightEntry.time_local ||
    flightEntry.timeLocal ||
    flightEntry.dep_time ||
    flightEntry.depTime ||
    flight.time_local ||
    flight.timeLocal ||
    flight.dep_time ||
    flight.depTime ||
    null
  );
}

function getFlightsArray(run) {
  if (!run) return [];
  if (Array.isArray(run.flights)) return [...run.flights];
  if (Array.isArray(run.flight_runs)) return [...run.flight_runs];
  if (Array.isArray(run.flightRuns)) return [...run.flightRuns];
  return [];
}

export function analyseRunConflicts(run) {
  const flights = getFlightsArray(run);
  flights.sort((a, b) => {
    const ta = getFlightTime(a) || "";
    const tb = getFlightTime(b) || "";
    return ta.localeCompare(tb);
  });

  const overloaded = flights.length > MAX_FLIGHTS_PER_RUN;

  const tightConnections = [];
  for (let i = 0; i < flights.length - 1; i += 1) {
    const cur = flights[i];
    const next = flights[i + 1];
    const gap = minutesBetween(getFlightTime(cur), getFlightTime(next));
    if (gap !== null && gap < MIN_GAP_MINUTES_TIGHT) {
      tightConnections.push({
        fromFlightId: getFlightId(cur),
        toFlightId: getFlightId(next),
        gapMinutes: gap,
      });
    }
  }

  return {
    overloaded,
    tightConnections,
    hasConflicts: overloaded || tightConnections.length > 0,
  };
}

function mapFlightsWithFlags(run, flights, tightConnections) {
  const tightMap = new Set(
    tightConnections.flatMap((c) => [c.fromFlightId, c.toFlightId]).filter(Boolean)
  );

  const flightsWithFlags = flights.map((f) => ({
    ...f,
    isTightConnection: tightMap.has(getFlightId(f)),
  }));

  if (Array.isArray(run.flights)) return flightsWithFlags;
  if (Array.isArray(run.flight_runs)) return flightsWithFlags;
  if (Array.isArray(run.flightRuns)) return flightsWithFlags;
  return flightsWithFlags;
}

export function decorateRunWithConflicts(run) {
  const analysis = analyseRunConflicts(run);
  const flights = getFlightsArray(run);
  const flightsWithFlags = mapFlightsWithFlags(run, flights, analysis.tightConnections);

  const decorated = { ...run, conflict: analysis };
  if (Array.isArray(run.flights)) return { ...decorated, flights: flightsWithFlags };
  if (Array.isArray(run.flight_runs)) return { ...decorated, flight_runs: flightsWithFlags };
  if (Array.isArray(run.flightRuns)) return { ...decorated, flightRuns: flightsWithFlags };
  return { ...decorated, flights: flightsWithFlags };
}

export function decorateRuns(runs) {
  return Array.isArray(runs) ? runs.map(decorateRunWithConflicts) : [];
}
