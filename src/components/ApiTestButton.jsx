import React, { useState } from "react";
import {
  fetchFlights,
  fetchRuns,
  fetchStatus,
  seedDemoDay,
} from "../lib/apiClient";
import "../styles/apiTest.css";

const ENABLE_DEV_SEED = import.meta.env.VITE_ENABLE_DEV_SEED !== "0";
const DEFAULT_AIRPORT = "YSSY";

/**
 * CWO-13: One-click API diagnostics for a given date.
 *
 * Calls:
 *   - /api/status?date=YYYY-MM-DD
 *   - /api/flights?date=YYYY-MM-DD&airport=YSSY&airline=ALL
 *   - /api/runs?date=YYYY-MM-DD&airport=YSSY&airline=ALL
 *
 * and shows a short summary plus optional detail.
 */
const ApiTestButton = ({ date, onAfterSeed, showSeedButton = true }) => {
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

    try {
      const results = await Promise.allSettled([
        fetchStatus(date),
        fetchFlights(date, "all", { airport: DEFAULT_AIRPORT }),
        fetchRuns(date, "ALL", { airport: DEFAULT_AIRPORT }),
      ]);

      const [statusRes, flightsRes, runsRes] = results.map((result) => {
        if (result.status === "fulfilled") {
          return { ok: true, status: result.value.status, data: result.value.data };
        }

        const err = result.reason || {};
        return {
          ok: false,
          status: err.status ?? "network",
          error: err.message || "Request failed",
          data: null,
        };
      });

      const flightsData = Array.isArray(flightsRes.data?.flights)
        ? flightsRes.data.flights
        : Array.isArray(flightsRes.data)
          ? flightsRes.data
          : [];
      const runsData = Array.isArray(runsRes.data?.runs)
        ? runsRes.data.runs
        : Array.isArray(runsRes.data)
          ? runsRes.data
          : [];

      // Derive some quick flags from statusRes, similar to SystemHealthBar.
      const statusPayload = statusRes.data || {};
      const backendOk =
        (statusPayload &&
          (statusPayload.ok === true ||
            statusPayload.backend_ok === true ||
            statusPayload.backend?.ok === true)) ||
        false;
      const dbOk =
        (statusPayload &&
          (statusPayload.db_ok === true ||
            statusPayload.database_ok === true ||
            statusPayload.database?.ok === true)) ||
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

  async function handleSeedDemoDay() {
    if (!ENABLE_DEV_SEED || !date || running) return;

    setRunning(true);
    setOpen(true);
    setSummary("Seeding demo day…");
    setDetails("");

    try {
      const res = await seedDemoDay(date);

      const payload = res.data || {};
      const flightsCreated =
        payload.summary?.flights_created ?? payload.flights_created;
      const runsCreated = payload.summary?.runs_created ?? payload.runs_created;

      if (flightsCreated != null || runsCreated != null) {
        const parts = [];
        if (flightsCreated != null)
          parts.push(`${flightsCreated} flight${
            flightsCreated === 1 ? "" : "s"
          }`);
        if (runsCreated != null)
          parts.push(`${runsCreated} run${runsCreated === 1 ? "" : "s"}`);
        setSummary(`Seeded demo day successfully (${parts.join(", ")}).`);
      } else {
        setSummary("Seeded demo day successfully.");
      }

      setDetails(res.data ? JSON.stringify(res.data, null, 2) : "");

      if (typeof onAfterSeed === "function") {
        await onAfterSeed();
      }
    } catch (err) {
      setSummary("Seed failed – see details.");
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

      {ENABLE_DEV_SEED && showSeedButton && (
        <button
          type="button"
          className="api-test__button api-test__button--secondary"
          onClick={handleSeedDemoDay}
          disabled={running || !date}
          title="Seed demo flights/runs for this date"
        >
          {running ? "Working…" : "Seed demo day"}
        </button>
      )}

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
