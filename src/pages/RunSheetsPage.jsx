import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SystemHealthBar from "../components/SystemHealthBar";
import { fetchJson } from "../utils/api";
import "../styles/runSheetsPage.css";

const DEFAULT_AIRPORT = "YSSY";
const DEFAULT_OPERATOR = "ALL";
const DEFAULT_SHIFT = "ALL";

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function displayValue(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function getRunId(run) {
  return (
    run?.id ??
    run?.run_id ??
    run?.runId ??
    run?.run_no ??
    run?.runNo ??
    run?.number ??
    null
  );
}

function getRunFlights(run) {
  const flights = run?.flights || run?.flight_runs || run?.flightRuns || run?.items;
  return Array.isArray(flights) ? flights : [];
}

function formatWindow(start, end) {
  const startLabel = displayValue(start, "");
  const endLabel = displayValue(end, "");
  if (!startLabel && !endLabel) return "-";
  if (startLabel && endLabel) return `${startLabel} – ${endLabel}`;
  return startLabel || endLabel;
}

function getFlightValue(flight, runFlight, keys) {
  for (const key of keys) {
    if (runFlight && runFlight[key] != null && runFlight[key] !== "") {
      return runFlight[key];
    }
    if (flight && flight[key] != null && flight[key] !== "") {
      return flight[key];
    }
  }
  return "";
}

const RunSheetsPage = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const initialParamsRef = useRef(new URLSearchParams(window.location.search));
  const autoPrintRef = useRef(initialParamsRef.current.get("print") === "1");

  const [date, setDate] = useState(
    initialParamsRef.current.get("date") || todayISO()
  );
  const [airport, setAirport] = useState(
    (initialParamsRef.current.get("airport") || DEFAULT_AIRPORT).toUpperCase()
  );
  const [operator, setOperator] = useState(
    (initialParamsRef.current.get("operator") || DEFAULT_OPERATOR).toUpperCase()
  );
  const [shift, setShift] = useState(
    (initialParamsRef.current.get("shift") || DEFAULT_SHIFT).toUpperCase()
  );
  const [runId, setRunId] = useState(
    initialParamsRef.current.get("runId") ||
      initialParamsRef.current.get("run_id") ||
      ""
  );
  const [runIndex, setRunIndex] = useState(
    initialParamsRef.current.get("runIndex") ||
      initialParamsRef.current.get("run_index") ||
      ""
  );

  const [runs, setRuns] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const printTriggeredRef = useRef(false);

  const updateUrl = useCallback(
    (next) => {
      const qs = new URLSearchParams();
      if (next.date) qs.set("date", next.date);
      if (next.airport) qs.set("airport", next.airport);
      if (next.operator) qs.set("operator", next.operator);
      if (next.shift) qs.set("shift", next.shift);
      if (next.runId) qs.set("runId", next.runId);
      if (next.runIndex) qs.set("runIndex", next.runIndex);
      if (next.print) qs.set("print", "1");
      const search = `?${qs.toString()}`;
      if (location.search === search) return;
      navigate({ pathname: "/runsheets", search }, { replace: true });
    },
    [location.search, navigate]
  );

  const loadRuns = useCallback(
    async (nextDate, nextAirport, nextOperator, nextShift) => {
      const d = (nextDate || "").trim();
      const a = (nextAirport || "").trim().toUpperCase();
      const op = (nextOperator || "").trim().toUpperCase();
      const sh = (nextShift || "").trim().toUpperCase();

      if (!d || !a) {
        setError("Date and airport are required.");
        setRuns([]);
        setMeta(null);
        return;
      }

      setLoading(true);
      setError("");

      try {
        const params = new URLSearchParams({
          date: d,
          airport: a,
          operator: op || DEFAULT_OPERATOR,
          shift: sh || DEFAULT_SHIFT,
        });
        const res = await fetchJson(`/api/runs?${params.toString()}`);

        if (!res?.ok) {
          setError(
            `Failed to load runs (${res?.status ?? "?"} – ${
              res?.error || "Unknown error"
            })`
          );
          setRuns([]);
          setMeta(null);
          return;
        }

        const data = res.data || {};
        const runsList = Array.isArray(data.runs) ? data.runs : [];

        setRuns(runsList);
        setMeta({
          date: data.local_date || data.date || d,
          airport: data.airport || a,
          count: data.count ?? runsList.length,
        });
      } catch (err) {
        setError(err?.message || "Failed to load runs.");
        setRuns([]);
        setMeta(null);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    loadRuns(date, airport, operator, shift);
    updateUrl({
      date,
      airport,
      operator,
      shift,
      runId,
      runIndex,
      print: autoPrintRef.current,
    });
  }, [date, airport, operator, shift, runId, runIndex, loadRuns, updateUrl]);

  const selectedRun = useMemo(() => {
    if (!runs.length) return null;

    if (runId) {
      const byId = runs.find((run) => String(getRunId(run)) === String(runId));
      if (byId) return byId;
    }

    if (runIndex) {
      const parsed = Number.parseInt(runIndex, 10);
      if (!Number.isNaN(parsed)) {
        const idx = parsed > 0 ? parsed - 1 : parsed;
        if (runs[idx]) return runs[idx];
      }
    }

    return runs[0];
  }, [runs, runId, runIndex]);

  const selectedRunIndex = useMemo(() => {
    if (!selectedRun) return -1;
    return runs.findIndex((run) => run === selectedRun);
  }, [runs, selectedRun]);

  const selectedRunKey = useMemo(() => {
    if (!selectedRun) return "";
    const id = getRunId(selectedRun);
    if (id != null) return `id:${id}`;
    return selectedRunIndex >= 0 ? `index:${selectedRunIndex + 1}` : "";
  }, [selectedRun, selectedRunIndex]);

  useEffect(() => {
    if (!autoPrintRef.current || printTriggeredRef.current || !selectedRun) return;
    printTriggeredRef.current = true;
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, [selectedRun]);

  const handleRefresh = () => {
    loadRuns(date, airport, operator, shift);
  };

  const handlePrint = () => {
    window.print();
  };

  const handleRunSelect = (value) => {
    if (value.startsWith("id:")) {
      setRunId(value.slice(3));
      setRunIndex("");
      return;
    }
    if (value.startsWith("index:")) {
      setRunIndex(value.slice(6));
      setRunId("");
    }
  };

  const runsTitle = useMemo(() => {
    if (!meta?.date) return "Run Sheet";
    const count = meta?.count;
    return typeof count === "number"
      ? `Run Sheet — ${meta.date} (${count} runs)`
      : `Run Sheet — ${meta.date}`;
  }, [meta]);

  return (
    <div className="runsheets-page">
      <header className="page-header runsheets-header">
        <div className="runsheets-header-title">
          <h1>{runsTitle}</h1>
          <p className="runsheets-header-subtitle">
            Printable per-run sheet sourced from /api/runs.
          </p>
        </div>

        <div className="runsheets-toolbar">
          <label>
            Date
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>

          <label>
            Airport
            <input
              value={airport}
              onChange={(event) => setAirport(event.target.value.toUpperCase())}
              placeholder={DEFAULT_AIRPORT}
            />
          </label>

          <label>
            Operator
            <input
              value={operator}
              onChange={(event) => setOperator(event.target.value.toUpperCase())}
              placeholder={DEFAULT_OPERATOR}
            />
          </label>

          <label>
            Shift
            <input
              value={shift}
              onChange={(event) => setShift(event.target.value.toUpperCase())}
              placeholder={DEFAULT_SHIFT}
            />
          </label>

          <label>
            Run
            <select
              value={selectedRunKey}
              onChange={(event) => handleRunSelect(event.target.value)}
              disabled={!runs.length}
            >
              {runs.length === 0 && <option value="">No runs</option>}
              {runs.map((run, index) => {
                const id = getRunId(run);
                const shiftLabel =
                  run?.shift_label || run?.shift?.label || run?.shift || "";
                const label = run?.label || run?.run_label || "";
                const optionLabel = [
                  label || (id != null ? `Run ${id}` : `Run ${index + 1}`),
                  shiftLabel ? `(${shiftLabel})` : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <option
                    key={id ?? index}
                    value={id != null ? `id:${id}` : `index:${index + 1}`}
                  >
                    {optionLabel}
                  </option>
                );
              })}
            </select>
          </label>

          <button type="button" onClick={handleRefresh} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>

          <button
            type="button"
            className="runsheets-print-button"
            onClick={handlePrint}
            disabled={!selectedRun}
          >
            Print
          </button>
        </div>
      </header>

      <SystemHealthBar date={date} />

      {loading && <div className="runsheets-status">Loading runs…</div>}

      {error && (
        <div className="runsheets-status runsheets-status--error">{error}</div>
      )}

      {!loading && !error && runs.length === 0 && (
        <div className="runsheets-status">No runs for this date.</div>
      )}

      {!loading && !error && runs.length > 0 && selectedRun && (
        <main className="runsheets-main">
          <RunSheetCard
            run={selectedRun}
            date={meta?.date || date}
            airport={meta?.airport || airport}
            index={selectedRunIndex}
          />
        </main>
      )}
    </div>
  );
};

function RunSheetCard({ run, date, airport, index }) {
  const runId = getRunId(run);
  const shiftLabel =
    run?.shift_label || run?.shift?.label || run?.shift || run?.shift_code || "";
  const truck =
    run?.truck_label || run?.truck_code || run?.truck_id || run?.truck || "";
  const runLabel = run?.label || run?.run_label || "";

  const startTime =
    run?.start_time ||
    run?.startTime ||
    run?.shift?.start_time ||
    run?.shift?.startTime ||
    "";
  const endTime =
    run?.end_time ||
    run?.endTime ||
    run?.shift?.end_time ||
    run?.shift?.endTime ||
    "";

  const volume =
    run?.estimated_volume ||
    run?.estimated_volume_l ||
    run?.volume ||
    run?.total_volume ||
    run?.volume_litres ||
    "";

  const flights = getRunFlights(run);
  const totalFlights = flights.length;

  return (
    <section className="runsheet-card">
      <header className="runsheet-header">
        <div className="runsheet-header-main">
          <div className="runsheet-title">
            {runLabel || (runId != null ? `Run ${runId}` : `Run ${index + 1}`)}
          </div>
          <div className="runsheet-subtitle">
            {displayValue(date)} · {displayValue(airport)}
          </div>
        </div>
        <div className="runsheet-header-meta">
          <div>
            <span className="runsheet-label">Shift</span>
            <span>{displayValue(shiftLabel)}</span>
          </div>
          <div>
            <span className="runsheet-label">Truck</span>
            <span>{displayValue(truck)}</span>
          </div>
          <div>
            <span className="runsheet-label">Run #</span>
            <span>{displayValue(runId ?? index + 1)}</span>
          </div>
        </div>
      </header>

      <div className="runsheet-summary">
        <div>
          <span className="runsheet-label">Total flights</span>
          <span>{displayValue(totalFlights)}</span>
        </div>
        <div>
          <span className="runsheet-label">Estimated volume</span>
          <span>{displayValue(volume)}</span>
        </div>
        <div>
          <span className="runsheet-label">Window</span>
          <span>{formatWindow(startTime, endTime)}</span>
        </div>
      </div>

      <table className="runsheet-table">
        <thead>
          <tr>
            <th>Flight</th>
            <th>STD/STA</th>
            <th>Bay/Stand</th>
            <th>Operator</th>
            <th>Destination/Origin</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {flights.length === 0 ? (
            <tr>
              <td colSpan={6} className="runsheet-table__empty">
                No flights in run.
              </td>
            </tr>
          ) : (
            flights.map((flightRun, rowIndex) => {
              const flight = flightRun?.flight || flightRun;
              const flightNumber = getFlightValue(flight, flightRun, [
                "flight_number",
                "flightNumber",
                "flight_no",
                "ident",
                "callsign",
              ]);
              const std = getFlightValue(flight, flightRun, [
                "std",
                "scheduled_time",
                "scheduled_off",
                "scheduled_departure",
                "departure_time",
                "dep_time",
                "time_local",
                "timeLocal",
              ]);
              const sta = getFlightValue(flight, flightRun, [
                "sta",
                "scheduled_on",
                "scheduled_arrival",
                "arrival_time",
                "arr_time",
                "eta",
              ]);
              const bay = getFlightValue(flight, flightRun, [
                "bay",
                "stand",
                "gate",
              ]);
              const operatorCode = getFlightValue(flight, flightRun, [
                "operator",
                "operator_code",
                "airline",
                "carrier",
              ]);
              const destination = getFlightValue(flight, flightRun, [
                "destination",
                "dest",
                "origin",
                "orig",
              ]);
              const notes = getFlightValue(flight, flightRun, [
                "notes",
                "note",
                "comment",
                "remarks",
              ]);
              const timeLabel = [std, sta].filter(Boolean).join(" / ");

              return (
                <tr key={flightRun?.id ?? flight?.id ?? rowIndex}>
                  <td>{displayValue(flightNumber)}</td>
                  <td>{displayValue(timeLabel)}</td>
                  <td>{displayValue(bay)}</td>
                  <td>{displayValue(operatorCode)}</td>
                  <td>{displayValue(destination)}</td>
                  <td>{displayValue(notes)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <footer className="runsheet-footer">
        <div className="runsheet-footer-meta">
          Generated {new Date().toLocaleString()}
        </div>
        <div className="runsheet-signatures">
          <div>
            <span className="runsheet-label">Driver signature</span>
            <span className="runsheet-line" />
          </div>
          <div>
            <span className="runsheet-label">Supervisor</span>
            <span className="runsheet-line" />
          </div>
          <div>
            <span className="runsheet-label">Notes</span>
            <span className="runsheet-line" />
          </div>
        </div>
      </footer>
    </section>
  );
}

export default RunSheetsPage;
