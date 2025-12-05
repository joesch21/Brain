import React, { useEffect, useMemo, useState } from "react";
import { fetchImportStatus } from "../lib/importStatus";

const STATUS_COLORS = {
  ok: { background: "#e8f5e9", color: "#1b5e20" },
  warn: { background: "#fff8e1", color: "#b26a00" },
  error: { background: "#ffebee", color: "#b71c1c" },
};

function StatusChip({ tone, label }) {
  const style = STATUS_COLORS[tone] || STATUS_COLORS.warn;
  return (
    <span
      className="import-status-chip"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "0.25rem",
        padding: "0.2rem 0.6rem",
        borderRadius: "999px",
        fontSize: "0.8rem",
        fontWeight: 600,
        ...style,
      }}
    >
      {label}
    </span>
  );
}

function formatTimestamp(isoString) {
  if (!isoString) return null;
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) return null;

  const formatter = new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const now = new Date();
  const diffMs = now.getTime() - parsed.getTime();
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  return {
    formatted: formatter.format(parsed),
    relative: diffHours <= 0 ? "just now" : `${diffHours}h ago`,
    parsed,
  };
}

function statusFromTimestamp(ts) {
  if (!ts) return { tone: "error", label: "Never imported" };

  const now = new Date();
  const sameDay =
    ts.getFullYear() === now.getFullYear() &&
    ts.getMonth() === now.getMonth() &&
    ts.getDate() === now.getDate();

  if (sameDay) return { tone: "ok", label: "Fresh" };
  return { tone: "warn", label: "Stale" };
}

const ImportStatusCard = () => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  const supportedAirlines = useMemo(() => {
    if (!data?.supported_airlines || !Array.isArray(data.supported_airlines)) {
      return [];
    }
    return data.supported_airlines;
  }, [data]);

  const lastImport = data?.last_import || {};

  async function loadStatus() {
    setLoading(true);
    setError("");
    try {
      const resp = await fetchImportStatus();
      setData(resp);
      setLastUpdated(new Date());
    } catch (err) {
      setError(
        err?.message || "System status unavailable (backend endpoint missing or offline)."
      );
      setData(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  const rows = useMemo(
    () =>
      supportedAirlines.map((code) => {
        const tsInfo = formatTimestamp(lastImport?.[code]);
        const status = statusFromTimestamp(tsInfo?.parsed);

        return {
          code,
          formatted: tsInfo?.formatted || "—",
          relative: tsInfo?.relative || "No data",
          status,
        };
      }),
    [lastImport, supportedAirlines]
  );

  const overallStatus = useMemo(() => {
    if (!rows.length) return { tone: "warn", label: "No configured airlines" };
    if (rows.every((row) => row.status.tone === "ok")) {
      return { tone: "ok", label: "Fresh today" };
    }
    if (rows.some((row) => row.status.tone === "ok")) {
      return { tone: "warn", label: "Partially fresh" };
    }
    return { tone: "warn", label: "Stale or missing" };
  }, [rows]);

  return (
    <div className="machine-room-card import-status-card">
      <div className="import-status-header">
        <div>
          <h3 style={{ margin: 0 }}>System Status</h3>
          <p className="muted" style={{ margin: 0 }}>
            Multi-airline import status
          </p>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            flexWrap: "wrap",
            justifyContent: "flex-end",
          }}
        >
          {!loading && !error && (
            <StatusChip
              tone={overallStatus.tone}
              label={`Data freshness: ${overallStatus.label}`}
            />
          )}
          <button type="button" onClick={loadStatus} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {loading && <p className="muted">Loading system status…</p>}

      {!loading && error && (
        <div className="import-status-error">
          <p style={{ margin: 0 }}>{error}</p>
          <button type="button" onClick={loadStatus} disabled={loading}>
            Retry
          </button>
        </div>
      )}

      {!loading && !error && (
        <>
          {supportedAirlines.length === 0 ? (
            <p className="muted">No configured airlines.</p>
          ) : (
            <table className="import-status-table">
              <thead>
                <tr>
                  <th>Airline</th>
                  <th>Last import (local)</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.code}>
                    <td>{row.code}</td>
                    <td>
                      <div>{row.formatted}</div>
                      <small className="muted">{row.relative}</small>
                    </td>
                    <td>
                      <StatusChip tone={row.status.tone} label={row.status.label} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <div className="import-status-footer">
            <small className="muted">
              Updated at {lastUpdated ? lastUpdated.toLocaleTimeString() : "—"}
            </small>
          </div>
        </>
      )}
    </div>
  );
};

export default ImportStatusCard;
