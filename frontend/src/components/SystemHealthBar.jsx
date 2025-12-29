import React, { useEffect, useState } from "react";
import { fetchStatus } from "../lib/apiClient";
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
const SystemHealthBar = ({ date, status: statusProp, statusError, loading }) => {
  const [internalLoading, setInternalLoading] = useState(false);
  const [internalError, setInternalError] = useState("");
  const [status, setStatus] = useState(null);

  // Sync with externally provided status/error/loading when present.
  useEffect(() => {
    if (
      statusProp !== undefined ||
      statusError !== undefined ||
      loading !== undefined
    ) {
      setStatus(statusProp || null);
      setInternalError(statusError || "");
      setInternalLoading(Boolean(loading));
    }
  }, [loading, statusError, statusProp]);

  useEffect(() => {
    if (
      statusProp !== undefined ||
      statusError !== undefined ||
      loading !== undefined
    ) {
      return undefined;
    }

    let cancelled = false;

    async function load() {
      setInternalLoading(true);
      setInternalError("");

      try {
        const res = await fetchStatus(date);
        if (!cancelled) {
          setStatus(res.data || {});
        }
      } catch (err) {
        if (!cancelled) {
          const statusLabel = err?.status ?? "network";
          const message = err?.message || "Unable to fetch system status";
          setInternalError(`Status ${statusLabel} – ${message}`);
          setStatus(null);
        }
      }

      if (!cancelled) {
        setInternalLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [date, loading, statusError, statusProp]);

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
  if (internalError || !backendOk) {
    mode = "error";
  } else if (!dbOk) {
    mode = "warn";
  }

  const rootClass =
    "system-health-bar system-health-bar--" + mode;

  return (
    <div className={rootClass}>
      <div className="system-health-bar__left">
        {internalLoading ? (
          <span className="system-health-bar__pill system-health-bar__pill--loading">
            <span className="dot dot--pulse" /> Checking system…
          </span>
        ) : internalError ? (
          <span className="system-health-bar__pill system-health-bar__pill--error">
            <span className="dot dot--error" /> Backend issue: {internalError}
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

      {!internalLoading && !internalError && (
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

