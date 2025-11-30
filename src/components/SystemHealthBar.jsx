import React, { useEffect, useState } from "react";
import { fetchJson } from "../utils/api";
import "../styles/systemHealthBar.css";

/**
 * Small status strip rendered at the top of main ops pages.
 *
 * It calls /api/status?date=YYYY-MM-DD and displays:
 * - Overall backend/DB status
 * - Flight / run counts, if available
 *
 * Props:
 *   date?: ISO date string (YYYY-MM-DD). Optional; if omitted, no date param.
 */
const SystemHealthBar = ({ date }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError("");

      const qs = date ? `?date=${encodeURIComponent(date)}` : "";
      const res = await fetchJson(`/api/status${qs}`);

      if (cancelled) return;

      if (!res.ok) {
        setError(
          `Status ${res.status || ""} – ${
            res.error || "Unable to fetch system status"
          }`
        );
        setStatus(null);
      } else {
        setStatus(res.data || {});
      }

      setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [date]);

  // Derive some flags defensively; different backends may expose slightly
  // different shapes, so we check a few common conventions.
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

  const flightCount =
    (status &&
      (status.flight_count ??
        status.flights_total ??
        status.flights?.total)) ||
    0;

  const runCount =
    (status &&
      (status.run_count ??
        status.runs_total ??
        status.runs?.total)) ||
    0;

  const unassignedCount =
    (status &&
      (status.unassigned_flights ??
        status.unassigned ??
        status.flights?.unassigned)) ||
    0;

  // Overall mode: ok / warn / error
  let mode = "ok";
  if (error || !backendOk) {
    mode = "error";
  } else if (!dbOk) {
    mode = "warn";
  }

  const rootClass =
    "system-health-bar system-health-bar--" + mode;

  return (
    <div className={rootClass}>
      <div className="system-health-bar__left">
        {loading ? (
          <span className="system-health-bar__pill system-health-bar__pill--loading">
            <span className="dot dot--pulse" /> Checking system…
          </span>
        ) : error ? (
          <span className="system-health-bar__pill system-health-bar__pill--error">
            <span className="dot dot--error" /> Backend issue: {error}
          </span>
        ) : (
          <>
            <span className="system-health-bar__pill system-health-bar__pill--ok">
              <span className="dot dot--ok" /> Backend
            </span>
            <span
              className={
                "system-health-bar__pill" +
                (dbOk
                  ? " system-health-bar__pill--ok"
                  : " system-health-bar__pill--warn")
              }
            >
              <span
                className={
                  dbOk ? "dot dot--ok" : "dot dot--warn"
                }
              />{" "}
              Office DB
            </span>
          </>
        )}
      </div>

      {!loading && !error && (
        <div className="system-health-bar__right">
          <span className="system-health-bar__metric">
            Flights: <strong>{flightCount}</strong>
          </span>
          <span className="system-health-bar__metric">
            Runs: <strong>{runCount}</strong>
          </span>
          <span className="system-health-bar__metric">
            Unassigned: <strong>{unassignedCount}</strong>
          </span>
        </div>
      )}
    </div>
  );
};

export default SystemHealthBar;

