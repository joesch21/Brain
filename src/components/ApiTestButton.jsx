import React, { useState } from "react";
import { fetchJson } from "../utils/api";
import "../styles/apiTest.css";

/**
 * CWO-13: One-click API diagnostics for a given date.
 *
 * Calls:
 *   - /api/status?date=YYYY-MM-DD
 *   - /api/flights?date=YYYY-MM-DD
 *   - /api/runs?date=YYYY-MM-DD
 *
 * and shows a short summary plus optional detail.
 */
const ApiTestButton = ({ date }) => {
  const [running, setRunning] = useState(false);
  const [open, setOpen] = useState(false);
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");

  async function handleRun() {
    if (running) return;

    setRunning(true);
    setOpen(true);
    setSummary("Running diagnostics…");
    setDetails("");

    const qs = date ? `?date=${encodeURIComponent(date)}` : "";

    try {
      const [statusRes, flightsRes, runsRes] = await Promise.all([
        fetchJson(`/api/status${qs}`),
        fetchJson(`/api/flights${qs}`),
        fetchJson(`/api/runs${qs}`),
      ]);

      const flightsData = Array.isArray(flightsRes.data)
        ? flightsRes.data
        : [];
      const runsData = Array.isArray(runsRes.data) ? runsRes.data : [];

      // Derive some quick flags from statusRes, similar to SystemHealthBar.
      const status = statusRes.data || {};
      const backendOk =
        (status &&
          (status.ok === true ||
            status.backend_ok === true ||
            status.backend?.ok === true)) ||
        false;
      const dbOk =
        (status &&
          (status.db_ok === true ||
            status.database_ok === true ||
            status.database?.ok === true)) ||
        false;

      const parts = [];

      if (statusRes.ok) {
        parts.push(
          `Status: OK (backend ${backendOk ? "OK" : "ISSUE"}, DB ${
            dbOk ? "OK" : "ISSUE"
          })`
        );
      } else {
        parts.push(
          `Status: ERROR (${statusRes.status || "?"}) – ${
            statusRes.error || "Unknown"
          }`
        );
      }

      if (flightsRes.ok) {
        parts.push(`Flights: ${flightsData.length}`);
      } else {
        parts.push(
          `Flights: ERROR (${flightsRes.status || "?"}) – ${
            flightsRes.error || "Unknown"
          }`
        );
      }

      if (runsRes.ok) {
        parts.push(`Runs: ${runsData.length}`);
      } else {
        parts.push(
          `Runs: ERROR (${runsRes.status || "?"}) – ${
            runsRes.error || "Unknown"
          }`
        );
      }

      setSummary(parts.join(" · "));

      const detailObj = {
        date: date || null,
        status: {
          ok: statusRes.ok,
          httpStatus: statusRes.status,
          error: statusRes.error,
        },
        flights: {
          ok: flightsRes.ok,
          httpStatus: flightsRes.status,
          error: flightsRes.error,
          count: flightsData.length,
        },
        runs: {
          ok: runsRes.ok,
          httpStatus: runsRes.status,
          error: runsRes.error,
          count: runsData.length,
        },
      };

      setDetails(JSON.stringify(detailObj, null, 2));
    } catch (err) {
      setSummary("Diagnostics failed – see details.");
      setDetails(err?.message || String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="api-test">
      <button
        type="button"
        className="api-test__button"
        onClick={handleRun}
        disabled={running}
        title="Run backend/DB diagnostics for this date"
      >
        {running ? "Testing…" : "Test API"}
      </button>

      {open && (
        <div className="api-test__panel">
          <div className="api-test__summary" aria-live="polite">
            {summary}
          </div>
          {details && (
            <pre className="api-test__details">{details}</pre>
          )}
        </div>
      )}
    </div>
  );
};

export default ApiTestButton;

