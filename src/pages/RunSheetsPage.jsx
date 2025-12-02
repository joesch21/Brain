import React, { useEffect, useState } from "react";
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

const RunSheetsPage = () => {
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [sheets, setSheets] = useState([]);
  const [meta, setMeta] = useState(null);

  async function loadRunSheets(selectedDate) {
    setLoading(true);
    setError("");
    const qs = `?date=${encodeURIComponent(selectedDate)}`;
    const res = await fetchJson(`/api/runsheets${qs}`);

    if (!res.ok) {
      setError(
        `Failed to load run sheets (${res.status} – ${
          res.error || "Unknown error"
        })`
      );
      setSheets([]);
      setMeta(null);
    } else {
      const data = res.data || {};
      setSheets(data.run_sheets || []);
      setMeta({
        date: data.date,
        count: data.count ?? (data.run_sheets || []).length,
      });
    }

    setLoading(false);
  }

  useEffect(() => {
    loadRunSheets(date);
  }, [date]);

  function handlePrintClick() {
    window.print();
  }

  return (
    <div className="runsheets-page">
      <header className="page-header">
        <h1>Daily Run Sheets</h1>
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
        <div className="runsheets-status runsheets-status--error">
          {error}
        </div>
      )}

      {!loading && !error && sheets.length === 0 && (
        <div className="runsheets-status">
          No run sheets for this date.
        </div>
      )}

      {!loading && !error && sheets.length > 0 && (
        <main className="runsheets-main">
          {sheets.map((sheet) => (
            <RunSheetCard key={sheet.id} sheet={sheet} />
          ))}
        </main>
      )}
    </div>
  );
};

function RunSheetCard({ sheet }) {
  const {
    truck_id,
    operator_name,
    shift_label,
    notes,
    entries = [],
    run_id,
  } = sheet;

  const heading = [
    operator_name || "Unassigned operator",
    shift_label || "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="runsheet-card">
      <header className="runsheet-card__header">
        <div className="runsheet-card__title">
          <h2>{heading || "Run Sheet"}</h2>
          <div className="runsheet-card__meta">
            {truck_id && <span>Truck ID: {truck_id}</span>}
            {run_id && <span>Run ID: {run_id}</span>}
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
            entries.map((e) => (
              <tr key={e.id}>
                <td>{e.flight_number}</td>
                <td>{e.destination}</td>
                <td>{e.scheduled_time}</td>
                <td>{e.bay}</td>
                <td>{e.registration}</td>
                <td>{e.status_code}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      {notes && (
        <footer className="runsheet-card__footer">
          <strong>Notes:</strong> {notes}
        </footer>
      )}
    </section>
  );
}

export default RunSheetsPage;
