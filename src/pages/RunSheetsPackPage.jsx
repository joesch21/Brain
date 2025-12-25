import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import RunSheetSection, {
  getRunFlights,
  getRunId,
} from "../components/RunSheetSection";
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

const RunSheetsPackPage = () => {
  const location = useLocation();
  const [runs, setRuns] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const params = useMemo(() => new URLSearchParams(location.search), [
    location.search,
  ]);

  const date = (params.get("date") || todayISO()).trim();
  const airport = (params.get("airport") || DEFAULT_AIRPORT)
    .trim()
    .toUpperCase();
  const operator = (params.get("operator") || DEFAULT_OPERATOR)
    .trim()
    .toUpperCase();
  const shift = (params.get("shift") || DEFAULT_SHIFT).trim().toUpperCase();

  const loadRuns = useCallback(async () => {
    if (!date || !airport) {
      setError("Date and airport are required.");
      setRuns([]);
      setMeta(null);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const query = new URLSearchParams({
        date,
        airport,
        operator: operator || DEFAULT_OPERATOR,
        shift: shift || DEFAULT_SHIFT,
      });
      const res = await fetchJson(`/api/runs?${query.toString()}`);

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
        date: data.local_date || data.date || date,
        airport: data.airport || airport,
        operator,
        shift,
        count: data.count ?? runsList.length,
      });
    } catch (err) {
      setError(err?.message || "Failed to load runs.");
      setRuns([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, [airport, date, operator, shift]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const totalFlights = useMemo(() => {
    return runs.reduce((sum, run) => sum + getRunFlights(run).length, 0);
  }, [runs]);

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="runsheets-page runsheets-pack-page">
      <header className="page-header runsheets-header runsheets-pack-header">
        <div className="runsheets-header-title">
          <h1>Run Sheet Pack</h1>
          <p className="runsheets-header-subtitle">
            All runs for {meta?.date || date} · {meta?.airport || airport}
          </p>
        </div>

        <div className="runsheets-pack-actions">
          <button
            type="button"
            className="runsheets-print-button"
            onClick={handlePrint}
            disabled={!runs.length}
          >
            Print Pack
          </button>
        </div>
      </header>

      <section className="runsheets-pack-summary">
        <div>
          <span className="runsheet-label">Date</span>
          <span>{meta?.date || date}</span>
        </div>
        <div>
          <span className="runsheet-label">Airport</span>
          <span>{meta?.airport || airport}</span>
        </div>
        <div>
          <span className="runsheet-label">Operator</span>
          <span>{operator || DEFAULT_OPERATOR}</span>
        </div>
        <div>
          <span className="runsheet-label">Shift</span>
          <span>{shift || DEFAULT_SHIFT}</span>
        </div>
        <div>
          <span className="runsheet-label">Total runs</span>
          <span>{meta?.count ?? runs.length}</span>
        </div>
        <div>
          <span className="runsheet-label">Total flights</span>
          <span>{totalFlights}</span>
        </div>
      </section>

      {runs.length > 0 && (
        <nav className="runsheets-pack-jumplinks">
          <span className="runsheet-label">Jump to:</span>
          {runs.map((run, index) => {
            const runId = getRunId(run);
            const label = run?.label || run?.run_label || "";
            return (
              <a key={runId ?? index} href={`#run-${index + 1}`}>
                {label || (runId != null ? `Run ${runId}` : `Run ${index + 1}`)}
              </a>
            );
          })}
        </nav>
      )}

      {loading && <div className="runsheets-status">Loading runs…</div>}

      {error && (
        <div className="runsheets-status runsheets-status--error">{error}</div>
      )}

      {!loading && !error && runs.length === 0 && (
        <div className="runsheets-status">No runs for this date.</div>
      )}

      {!loading && !error && runs.length > 0 && (
        <main className="runsheets-pack-main">
          {runs.map((run, index) => (
            <RunSheetSection
              key={getRunId(run) ?? index}
              run={run}
              date={meta?.date || date}
              airport={meta?.airport || airport}
              index={index}
              sectionId={`run-${index + 1}`}
              className="runsheet-pack-card"
            />
          ))}
        </main>
      )}
    </div>
  );
};

export default RunSheetsPackPage;
