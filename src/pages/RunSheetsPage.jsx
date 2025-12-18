// src/pages/RunSheetsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import SystemHealthBar from "../components/SystemHealthBar";
import { fetchJson } from "../utils/api";
import "../styles/runSheetsPage.css";

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v);
}

function buildRunSheetQs(selectedDate) {
  return `?date=${encodeURIComponent(selectedDate)}`;
}

const RunSheetsPage = () => {
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sheets, setSheets] = useState([]);
  const [meta, setMeta] = useState(null);

  const isMountedRef = useRef(true);

  async function loadRunSheets(selectedDate) {
    const d = safeStr(selectedDate).trim();
    if (!d) return;

    setLoading(true);
    setError("");

    try {
      const qs = buildRunSheetQs(d);
      const res = await fetchJson(`/api/runsheets${qs}`);

      if (!isMountedRef.current) return;

      if (!res?.ok) {
        setError(
          `Failed to load run sheets (${res?.status ?? "?"} – ${
            res?.error || "Unknown error"
          })`
        );
        setSheets([]);
        setMeta(null);
        return;
      }

      const data = res.data || {};
      const runSheets = Array.isArray(data.run_sheets) ? data.run_sheets : [];

      setSheets(runSheets);
      setMeta({
        date: data.date || d,
        count: data.count ?? runSheets.length,
      });
    } catch (e) {
      if (!isMountedRef.current) return;
      setError(e?.message || "Failed to load run sheets.");
      setSheets([]);
      setMeta(null);
    } finally {
      if (!isMountedRef.current) return;
      setLoading(false);
    }
  }

  useEffect(() => {
    isMountedRef.current = true;
    loadRunSheets(date);
    return () => {
      isMountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  function handlePrintClick() {
    window.print();
  }

  const titleSuffix = useMemo(() => {
    if (!meta?.date) return "";
    const c = meta?.count;
    return typeof c === "number" ? ` — ${meta.date} (${c})` : ` — ${meta.date}`;
  }, [meta]);

  return (
    <div className="runsheets-page">
      <header className="page-header">
        <h1>Daily Run Sheets{titleSuffix}</h1>

        <div className="runsheets-header-controls">
          <label>
            Date:{" "}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>

          <button
            type="button"
            onClick={() => loadRunSheets(date)}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>

          <button
            type="button"
            onClick={handlePrintClick}
            className="runsheets-print-button"
          >
            Print run sheets
          </button>
        </div>
      </header>

      <SystemHealthBar date={date} />

      {loading && <div className="runsheets-status">Loading run sheets…</div>}

      {error && (
        <div className="runsheets-status runsheets-status--error">{error}</div>
      )}

      {!loading && !error && sheets.length === 0 && (
        <div className="runsheets-status">No run sheets for this date.</div>
      )}

      {!loading && !error && sheets.length > 0 && (
        <main className="runsheets-main">
          {sheets.map((sheet) => (
            <RunSheetCard key={sheet.id ?? sheet.run_id ?? JSON.stringify(sheet)} sheet={sheet} />
          ))}
        </main>
      )}
    </div>
  );
};

function RunSheetCard({ sheet }) {
  const truckId = sheet?.truck_id ?? sheet?.truck ?? "";
  const operatorName = sheet?.operator_name ?? sheet?.operator ?? "";
  const shiftLabel = sheet?.shift_label ?? sheet?.shift ?? "";
  const notes = sheet?.notes ?? "";
  const entries = Array.isArray(sheet?.entries) ? sheet.entries : [];
  const runId = sheet?.run_id ?? sheet?.id ?? "";

  const heading = [operatorName || "Unassigned operator", shiftLabel || ""]
    .filter(Boolean)
    .join(" · ");

  const openHref = runId ? `/run-sheet?run_id=${encodeURIComponent(runId)}` : "";

  return (
    <section className="runsheet-card">
      <header className="runsheet-card__header">
        <div className="runsheet-card__title">
          <h2>{heading || "Run Sheet"}</h2>

          <div className="runsheet-card__meta">
            {truckId ? <span>Truck ID: {truckId}</span> : null}
            {runId ? <span>Run ID: {runId}</span> : null}
            {openHref ? (
              <span>
                <a href={openHref}>Open table view</a>
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <table className="runsheet-table">
        <thead>
          <tr>
            <th>Flight</th>
            <th>Dest</th>
            <th>Time</th>
            <th>Bay</th>
            <th>Reg</th>
            <th>Status</th>
          </tr>
        </thead>

        <tbody>
          {entries.length === 0 ? (
            <tr>
              <td colSpan={6} className="runsheet-table__empty">
                No flights on this run sheet.
              </td>
            </tr>
          ) : (
            entries.map((e, idx) => (
              <tr key={e?.id ?? `${e?.flight_number ?? "row"}-${idx}`}>
                <td>{safeStr(e?.flight_number)}</td>
                <td>{safeStr(e?.destination)}</td>
                <td>{safeStr(e?.scheduled_time)}</td>
                <td>{safeStr(e?.bay)}</td>
                <td>{safeStr(e?.registration)}</td>
                <td>{safeStr(e?.status_code)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {notes ? (
        <footer className="runsheet-card__footer">
          <strong>Notes:</strong> {notes}
        </footer>
      ) : null}
    </section>
  );
}

export default RunSheetsPage;
