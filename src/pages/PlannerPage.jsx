import React, { useEffect, useMemo, useState } from "react";
import "../styles/planner.css";

// --- small helpers ---------------------------------------------------------

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Extract airline code from a flight number, e.g. "JQ719" -> "JQ".
function getAirlineCode(flightNumber) {
  if (!flightNumber || typeof flightNumber !== "string") return "UNK";
  let prefix = "";
  for (const ch of flightNumber) {
    if (/[A-Za-z]/.test(ch)) prefix += ch;
    else break;
  }
  return prefix || "UNK";
}

// Parse "HH:MM" or "HH:MM:SS" into minutes since midnight.
function parseTimeToMinutes(timeStr) {
  if (!timeStr || typeof timeStr !== "string") return null;
  const parts = timeStr.split(":");
  if (parts.length < 2) return null;
  const hours = Number(parts[0]);
  const minutes = Number(parts[1]);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function classifyTimeBand(timeStr) {
  const mins = parseTimeToMinutes(timeStr);
  if (mins == null) return "UNKNOWN";
  if (mins >= 5 * 60 && mins <= 12 * 60) return "AM"; // 05:00–12:00
  if (mins >= 12 * 60 + 1 && mins <= 23 * 60) return "PM"; // 12:01–23:00
  return "OTHER";
}

// Figure out which grouping a run belongs to, based on shift.start_time.
function classifyRunGroup(run) {
  const shift = run.shift || {};
  const mins = parseTimeToMinutes(shift.start_time || shift.startTime);
  if (mins == null) return "OTHER";
  if (mins < 12 * 60) return "AM";
  if (mins < 17 * 60) return "MIDDAY";
  return "EVENING";
}

// --- summary computation ----------------------------------------------------

function computeSummary(flights, flightToRunMap) {
  const summary = {
    total: 0,
    am: { total: 0, byAirline: {} },
    pm: { total: 0, byAirline: {} },
    unassigned: 0,
  };

  if (!Array.isArray(flights)) return summary;

  for (const f of flights) {
    summary.total += 1;

    const airline = getAirlineCode(f.flight_number || f.flightNumber);
    const timeStr = f.time_local || f.timeLocal || f.time || null;
    const band = classifyTimeBand(timeStr);

    const key = `${f.flight_number || f.flightNumber || ""}|${
      f.time_local || f.timeLocal || ""
    }`;
    const isAssigned = Boolean(flightToRunMap[key]);

    if (!isAssigned) summary.unassigned += 1;

    if (band === "AM") {
      summary.am.total += 1;
      summary.am.byAirline[airline] =
        (summary.am.byAirline[airline] || 0) + 1;
    } else if (band === "PM") {
      summary.pm.total += 1;
      summary.pm.byAirline[airline] =
        (summary.pm.byAirline[airline] || 0) + 1;
    }
  }

  return summary;
}

function formatByAirline(byAirline) {
  const entries = Object.entries(byAirline || {});
  if (!entries.length) return "—";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => `${code} ${count}`)
    .join(", ");
}

// --- subcomponents ----------------------------------------------------------

/**
 * Left column: list of all flights for the day.
 */
function FlightListColumn({
  flights,
  flightToRunMap,
  selectedFlightKey,
  onSelectFlight,
}) {
  return (
    <section className="planner-column planner-column--left">
      <h3>Flights</h3>
      <div className="planner-list">
        <table className="planner-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Flight</th>
              <th>Dest</th>
              <th>Airline</th>
              <th>Assigned</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((f) => {
              const flightNumber = f.flight_number || f.flightNumber;
              const timeStr = f.time_local || f.timeLocal || "";
              const dest = f.destination || f.dest || "";
              const airline = getAirlineCode(flightNumber);
              const key = `${flightNumber}|${timeStr}`;
              const assignedRun = flightToRunMap[key];
              const isSelected = selectedFlightKey === key;

              return (
                <tr
                  key={key}
                  className={
                    "planner-row" +
                    (isSelected ? " planner-row--selected" : "")
                  }
                  onClick={() => onSelectFlight(key, assignedRun?.runId)}
                >
                  <td>{timeStr}</td>
                  <td>{flightNumber}</td>
                  <td>{dest}</td>
                  <td>{airline}</td>
                  <td>
                    {assignedRun ? (
                      <span className="tag tag--assigned">
                        {assignedRun.operator} • {assignedRun.runLabel}
                      </span>
                    ) : (
                      <span className="tag tag--unassigned">Unassigned</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Center column: run cards grouped by shift band.
 */
function RunsGridColumn({ runs, selectedRunId, onSelectRun }) {
  const grouped = useMemo(() => {
    const groups = { AM: [], MIDDAY: [], EVENING: [], OTHER: [] };
    for (const run of runs) {
      const g = classifyRunGroup(run);
      groups[g] = groups[g] || [];
      groups[g].push(run);
    }
    return groups;
  }, [runs]);

  const groupOrder = [
    ["AM", "AM (05:00–12:00)"],
    ["MIDDAY", "Midday (12:00–17:00)"],
    ["EVENING", "Evening (17:00–23:00)"],
    ["OTHER", "Other"],
  ];

  return (
    <section className="planner-column planner-column--center">
      <h3>Runs</h3>
      <div className="planner-runs-grid">
        {groupOrder.map(([key, label]) => {
          const list = grouped[key] || [];
          if (!list.length) return null;
          return (
            <div key={key} className="planner-run-group">
              <h4>{label}</h4>
              <div className="planner-run-group-grid">
                {list.map((run) => {
                  const shift = run.shift || {};
                  const runLabel = run.label || run.run_label || "";
                  const op = run.operator_code || shift.operator_code || "";
                  const truck = run.truck_id || "";
                  const flights =
                    run.flights || run.flight_runs || run.flightRuns || [];

                  return (
                    <div
                      key={run.id}
                      className={
                        "planner-run-card" +
                        (selectedRunId === run.id
                          ? " planner-run-card--selected"
                          : "")
                      }
                      onClick={() => onSelectRun(run.id)}
                    >
                      <div className="planner-run-card-header">
                        <div>
                          <strong>{op || "RUN"}</strong> • {runLabel}
                        </div>
                        <div className="planner-run-card-sub">
                          {shift.start_time || shift.startTime} –{" "}
                          {shift.end_time || shift.endTime}
                          {truck ? ` • Truck ${truck}` : null}
                        </div>
                      </div>
                      <table className="planner-table planner-table--compact">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Flight</th>
                            <th>Dest</th>
                          </tr>
                        </thead>
                        <tbody>
                          {flights.map((fr) => {
                            const flt = fr.flight || fr; // some APIs embed flight object
                            const fn =
                              flt.flight_number || flt.flightNumber || "";
                            const time =
                              flt.time_local || flt.timeLocal || "";
                            const dest = flt.destination || flt.dest || "";
                            const key = `${fn}|${time}`;
                            return (
                              <tr key={fr.id || key}>
                                <td>{time}</td>
                                <td>{fn}</td>
                                <td>{dest}</td>
                              </tr>
                            );
                          })}
                          {flights.length === 0 && (
                            <tr>
                              <td colSpan={3} style={{ fontStyle: "italic" }}>
                                No flights assigned
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Right column: run sheet view for the selected run.
 */
function RunSheetColumn({ runs, selectedRunId }) {
  const selectedRun =
    runs.find((r) => r.id === selectedRunId) || runs[0] || null;

  if (!selectedRun) {
    return (
      <section className="planner-column planner-column--right">
        <h3>Run sheet</h3>
        <p>Select a run card to view its run sheet.</p>
      </section>
    );
  }

  const shift = selectedRun.shift || {};
  const flights =
    selectedRun.flights ||
    selectedRun.flight_runs ||
    selectedRun.flightRuns ||
    [];

  const op = selectedRun.operator_code || shift.operator_code || "";
  const truck = selectedRun.truck_id || "";
  const runLabel = selectedRun.label || selectedRun.run_label || "";

  return (
    <section className="planner-column planner-column--right">
      <h3>Run sheet</h3>
      <div className="run-sheet-header">
        <div>
          <strong>Operator:</strong> {op || "—"}
        </div>
        <div>
          <strong>Vehicle No.:</strong> {truck || "—"}
        </div>
        <div>
          <strong>Run:</strong> {runLabel}
        </div>
      </div>
      <div className="planner-list">
        <table className="planner-table">
          <thead>
            <tr>
              <th>Flight</th>
              <th>Dest</th>
              <th>Time</th>
              <th>Bay</th>
              <th>Rego</th>
              <th>On time</th>
              <th>Status</th>
              <th>Start fig</th>
              <th>Uplift</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((fr) => {
              const flt = fr.flight || fr;
              const fn = flt.flight_number || flt.flightNumber || "";
              const dest = flt.destination || flt.dest || "";
              const time = flt.time_local || flt.timeLocal || "";
              const key = `${fn}|${time}`;
              return (
                <tr key={fr.id || key}>
                  <td>{fn}</td>
                  <td>{dest}</td>
                  <td>{time}</td>
                  <td></td>
                  <td></td>
                  <td></td>
                  <td>{fr.status || "planned"}</td>
                  <td></td>
                  <td></td>
                </tr>
              );
            })}
            {flights.length === 0 && (
              <tr>
                <td colSpan={9} style={{ fontStyle: "italic" }}>
                  No flights assigned to this run.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- main page --------------------------------------------------------------

const PlannerPage = () => {
  const [date, setDate] = useState(todayISO());
  const [flights, setFlights] = useState([]);
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [error, setError] = useState("");
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [selectedFlightKey, setSelectedFlightKey] = useState(null);

  const flightToRunMap = useMemo(() => {
    const map = {};
    for (const run of runs) {
      const shift = run.shift || {};
      const op = run.operator_code || shift.operator_code || "";
      const runLabel = run.label || run.run_label || "";
      const flightsArr =
        run.flights || run.flight_runs || run.flightRuns || [];
      for (const fr of flightsArr) {
        const flt = fr.flight || fr;
        const fn = flt.flight_number || flt.flightNumber || "";
        const timeStr = flt.time_local || flt.timeLocal || "";
        const key = `${fn}|${timeStr}`;
        map[key] = { runId: run.id, operator: op, runLabel };
      }
    }
    return map;
  }, [runs]);

  const summary = useMemo(
    () => computeSummary(flights, flightToRunMap),
    [flights, flightToRunMap]
  );

  useEffect(() => {
    if (!date) return undefined;
    const controller = new AbortController();

    async function loadFlights() {
      try {
        setLoading(true);
        setError("");
        const resp = await fetch(`/api/flights?date=${encodeURIComponent(date)}`, {
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(
            `Failed to load flights (${resp.status}): ${text || "Unknown error"}`
          );
        }
        const data = await resp.json();
        const list = Array.isArray(data.flights) ? data.flights : data;
        setFlights(list || []);
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error(err);
        setError(err.message || "Error loading flights");
        setFlights([]);
      } finally {
        setLoading(false);
      }
    }

    loadFlights();
    return () => controller.abort();
  }, [date]);

  useEffect(() => {
    if (!date) return undefined;
    const controller = new AbortController();

    async function loadRuns() {
      try {
        setLoadingRuns(true);
        setError("");
        const resp = await fetch(`/api/runs?date=${encodeURIComponent(date)}`, {
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(
            `Failed to load runs (${resp.status}): ${text || "Unknown error"}`
          );
        }
        const data = await resp.json();
        const list = Array.isArray(data.runs) ? data.runs : data;
        setRuns(list || []);
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error(err);
        setError(err.message || "Error loading runs");
        setRuns([]);
      } finally {
        setLoadingRuns(false);
      }
    }

    loadRuns();
    return () => controller.abort();
  }, [date]);

  async function handleAutoAssign() {
    if (!date) return;
    try {
      const resp = await fetch("/api/assignments/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Auto-assign failed (${resp.status}): ${text || "Unknown error"}`
        );
      }

      setLoadingRuns(true);
      const runsResp = await fetch(`/api/runs?date=${encodeURIComponent(date)}`);
      if (!runsResp.ok) {
        const text = await runsResp.text();
        throw new Error(
          `Failed to refresh runs (${runsResp.status}): ${text || "Unknown error"}`
        );
      }
      const runsData = await runsResp.json();
      setRuns(Array.isArray(runsData.runs) ? runsData.runs : runsData || []);

      setLoading(true);
      const flightsResp = await fetch(
        `/api/flights?date=${encodeURIComponent(date)}`
      );
      if (!flightsResp.ok) {
        const text = await flightsResp.text();
        throw new Error(
          `Failed to refresh flights (${flightsResp.status}): ${text || "Unknown error"}`
        );
      }
      const flightsData = await flightsResp.json();
      setFlights(
        Array.isArray(flightsData.flights)
          ? flightsData.flights
          : flightsData || []
      );
    } catch (err) {
      console.error(err);
      setError(err.message || "Error during auto-assign.");
    } finally {
      setLoading(false);
      setLoadingRuns(false);
    }
  }

  function handleSelectFlight(flightKey, runId) {
    setSelectedFlightKey(flightKey);
    if (runId) setSelectedRunId(runId);
  }

  function handleSelectRun(runId) {
    setSelectedRunId(runId);
  }

  return (
    <div className="planner-page">
      <header className="planner-header">
        <div className="planner-header-left">
          <h2>Daily Ops Planner</h2>
          <label>
            Date:{" "}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        <div className="planner-header-right">
          <button type="button" onClick={handleAutoAssign}>
            Auto-assign runs
          </button>
        </div>
      </header>

      {(loading || loadingRuns) && (
        <div className="planner-status">Loading data…</div>
      )}
      {error && <div className="planner-status planner-status--error">{error}</div>}

      <main className="planner-main">
        <FlightListColumn
          flights={flights}
          flightToRunMap={flightToRunMap}
          selectedFlightKey={selectedFlightKey}
          onSelectFlight={handleSelectFlight}
        />
        <RunsGridColumn
          runs={runs}
          selectedRunId={selectedRunId}
          onSelectRun={handleSelectRun}
        />
        <RunSheetColumn runs={runs} selectedRunId={selectedRunId} />
      </main>

      <footer className="planner-footer">
        <div className="planner-summary">
          <span>
            <strong>Total flights:</strong> {summary.total}
          </span>
          <span>
            <strong>AM (05:00–12:00):</strong> {summary.am.total} [
            {formatByAirline(summary.am.byAirline)}]
          </span>
          <span>
            <strong>PM (12:01–23:00):</strong> {summary.pm.total} [
            {formatByAirline(summary.pm.byAirline)}]
          </span>
          <span>
            <strong>Unassigned:</strong> {summary.unassigned}
          </span>
        </div>
      </footer>
    </div>
  );
};

export default PlannerPage;
