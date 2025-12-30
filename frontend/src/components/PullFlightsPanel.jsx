import React, { useMemo, useState } from "react";
import { pullFlights } from "../lib/apiClient";

// EWOT: PullFlightsPanel lets the user trigger flights/pull manually and shows the last result.

function formatPullMessage(result, { date, airport, airline }) {
  if (!result) return "";
  if (!result.ok) {
    return `Pull failed for ${date || "date"} @ ${airport || "airport"} (${airline || "ALL"}) — ${
      result.error || "Request failed"
    }`;
  }
  const status = result.data?.status ?? result.status;
  const message =
    result.data?.message || result.data?.summary || "Pull request accepted.";
  return `Pulled flights for ${date} @ ${airport} (${airline || "ALL"})${
    status != null ? ` — status ${status}` : ""
  }. ${message}`;
}

export default function PullFlightsPanel({ airport, date, airline }) {
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  const resolvedAirline = useMemo(
    () => (airline && airline.trim() ? airline : "ALL"),
    [airline]
  );

  const canPull = Boolean(airport && date);

  async function doPull() {
    if (!canPull || running) return;
    setRunning(true);

    const result = await pullFlights(date, resolvedAirline, {
      airport,
      timeoutMs: 60000,
    });
    setLastResult(result);
    setRunning(false);
  }

  const message = formatPullMessage(lastResult, {
    date,
    airport,
    airline: resolvedAirline,
  });

  return (
    <div className="machine-room-card" style={{ marginTop: "1rem" }}>
      <h4>Manual flights pull</h4>
      <p className="muted" style={{ marginTop: "0.25rem" }}>
        Pulls flights only when you click the button. No automatic retries.
      </p>
      <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
        <button type="button" onClick={doPull} disabled={!canPull || running}>
          {running ? "Pulling…" : "Pull flights for this day"}
        </button>
        <div style={{ fontSize: "0.85rem", opacity: 0.8 }}>
          Airport: <b>{airport || "—"}</b> · Date: <b>{date || "—"}</b> · Airline:{" "}
          <b>{resolvedAirline}</b>
        </div>
      </div>
      {lastResult && (
        <div style={{ marginTop: "0.75rem" }}>
          <div
            className={lastResult.ok ? "jq-import-status--ok" : "jq-import-status--error"}
            style={{ padding: "0.5rem 0.75rem", borderRadius: "6px" }}
          >
            {message}
          </div>
          <pre style={{ marginTop: "0.5rem", whiteSpace: "pre-wrap" }}>
            {JSON.stringify(lastResult, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
