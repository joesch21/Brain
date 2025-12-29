import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SystemHealthBar from "../components/SystemHealthBar";
import RunSheetSection, { getRunId } from "../components/RunSheetSection";
import { getAssignmentsOptional } from "../utils/optionalAssignments";
import { fetchJson } from "../utils/api";
import { apiUrl } from "../lib/apiBase";
import "../index.css";
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
    (
      initialParamsRef.current.get("airline") ||
      initialParamsRef.current.get("operator") ||
      DEFAULT_OPERATOR
    ).toUpperCase()
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
  const [assignmentsState, setAssignmentsState] = useState({
    status: "idle",
    assignments: [],
    error: "",
  });

  const printTriggeredRef = useRef(false);

  const updateUrl = useCallback(
    (next) => {
      const qs = new URLSearchParams();
      if (next.date) qs.set("date", next.date);
      if (next.airport) qs.set("airport", next.airport);
      if (next.operator) qs.set("airline", next.operator);
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
          airline: op || DEFAULT_OPERATOR,
          shift: sh || DEFAULT_SHIFT,
        });
        const res = await fetchJson(apiUrl(`api/runs?${params.toString()}`));

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

  useEffect(() => {
    if (!date || !airport) {
      setAssignmentsState({ status: "idle", assignments: [], error: "" });
      return;
    }

    const controller = new AbortController();
    let active = true;

    setAssignmentsState((prev) => ({
      ...prev,
      status: "loading",
      error: "",
    }));

    getAssignmentsOptional({
      date,
      airport,
      operator,
      shift,
      signal: controller.signal,
    }).then((result) => {
      if (!active || controller.signal.aborted) return;
      if (result.ok) {
        setAssignmentsState({
          status: "loaded",
          assignments: result.assignments || [],
          error: "",
        });
      } else {
        setAssignmentsState({
          status: "unavailable",
          assignments: [],
          error: result.error || "unavailable",
        });
      }
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [date, airport, operator, shift]);

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
    <div className="runsheets-page runsheet">
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
          <RunSheetSection
            run={selectedRun}
            date={meta?.date || date}
            airport={meta?.airport || airport}
            index={selectedRunIndex}
            assignmentsStatus={assignmentsState.status}
            assignments={assignmentsState.assignments}
          />
        </main>
      )}
    </div>
  );
};

export default RunSheetsPage;
