import React, { useEffect, useMemo, useState } from "react";

const todayISO = () => new Date().toISOString().slice(0, 10);

const PROBES = [
  {
    key: "contract",
    name: "API Contract",
    buildPath: () => "/api/contract",
  },
  {
    key: "wiring-status",
    name: "Wiring Status",
    buildPath: () => "/api/wiring-status",
  },
  {
    key: "flights",
    name: "Flights (today)",
    buildPath: (date) => `/api/flights?date=${encodeURIComponent(date)}&airport=YSSY&operator=ALL`,
  },
  {
    key: "runs",
    name: "Runs (today)",
    buildPath: (date) => `/api/runs?date=${encodeURIComponent(date)}&airport=YSSY&operator=ALL`,
  },
];

const statusColor = (status) => {
  if (status === "PASS") return "#0f9d58";
  if (status === "FAIL") return "#d93025";
  return "#5f6368";
};

const truncateJson = (value, maxLength = 220) => {
  const str =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value, null, 2);
          } catch (err) {
            return String(value);
          }
        })();

  if (!str) return "(empty)";
  if (str.length <= maxLength) return str;
  return `${str.slice(0, maxLength)}…`;
};

const extractDrift = (data) => {
  if (!data || typeof data !== "object") return null;
  const keys = ["schema_required_ok", "schema_missing_count", "schema_fingerprint"];
  const present = keys.reduce((acc, key) => {
    if (key in data) acc[key] = data[key];
    return acc;
  }, {});
  return Object.keys(present).length ? present : null;
};

const WiringTestPage = () => {
  const [date] = useState(todayISO());
  const [results, setResults] = useState({});
  const [loading, setLoading] = useState(false);

  const probes = useMemo(() => PROBES.map((probe) => ({ ...probe, url: probe.buildPath(date) })), [date]);

  const runProbes = async () => {
    setLoading(true);
    const nextResults = {};

    for (const probe of probes) {
      const url = probe.url;
      try {
        const resp = await fetch(url, { credentials: "include" });
        const status = resp.status;
        const contentType = resp.headers?.get("content-type") || "";
        const data = contentType.includes("application/json") ? await resp.json() : await resp.text();
        const ok = resp.ok;
        nextResults[probe.key] = {
          status: ok ? "PASS" : "FAIL",
          url,
          rawStatus: status,
          payload: data,
          drift: extractDrift(data),
        };
      } catch (err) {
        nextResults[probe.key] = {
          status: "FAIL",
          url,
          rawStatus: null,
          payload: err?.message || "Network error",
          drift: null,
        };
      }
    }

    setResults(nextResults);
    setLoading(false);
  };

  useEffect(() => {
    runProbes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main style={{ padding: "1.5rem" }}>
      <header style={{ marginBottom: "1rem" }}>
        <p style={{ color: "#5f6368", fontSize: "0.9rem", marginBottom: "0.25rem" }}>
          Machine Room Diagnostic
        </p>
        <h1 style={{ margin: 0 }}>Wiring &amp; Drift Check</h1>
        <p style={{ color: "#5f6368", maxWidth: "720px" }}>
          This read-only view pings the Brain API surfaces that proxy CC2. Each row shows a
          PASS/FAIL along with truncated response details so wiring or schema drift problems are
          obvious even when CC2 is down.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginTop: "0.5rem" }}>
          <div style={{ color: "#5f6368" }}>
            <strong>Date:</strong> {date}
          </div>
          <button
            type="button"
            onClick={runProbes}
            disabled={loading}
            style={{
              padding: "0.4rem 0.8rem",
              background: "#1967d2",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "Running…" : "Re-run probes"}
          </button>
        </div>
      </header>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "640px" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #dadce0" }}>
              <th style={{ padding: "0.5rem" }}>Probe</th>
              <th style={{ padding: "0.5rem" }}>URL</th>
              <th style={{ padding: "0.5rem", width: "100px" }}>Status</th>
              <th style={{ padding: "0.5rem" }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {probes.map((probe) => {
              const result = results[probe.key];
              const drift = result?.drift;
              return (
                <tr key={probe.key} style={{ borderBottom: "1px solid #f1f3f4" }}>
                  <td style={{ padding: "0.5rem", fontWeight: 600 }}>{probe.name}</td>
                  <td style={{ padding: "0.5rem", color: "#5f6368", fontFamily: "monospace", fontSize: "0.95rem" }}>
                    {probe.url}
                  </td>
                  <td style={{ padding: "0.5rem", fontWeight: 700, color: statusColor(result?.status) }}>
                    {result?.status || (loading ? "…" : "Not run")}
                    {typeof result?.rawStatus === "number" && (
                      <span style={{ display: "block", fontSize: "0.85rem", fontWeight: 400, color: "#5f6368" }}>
                        HTTP {result.rawStatus}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "0.5rem", fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                    {result ? truncateJson(result.payload) : loading ? "Loading…" : "Not run"}
                    {drift && (
                      <div
                        style={{
                          marginTop: "0.35rem",
                          padding: "0.4rem 0.5rem",
                          background: "#fff8e1",
                          border: "1px solid #f4b400",
                          borderRadius: "4px",
                        }}
                      >
                        <div style={{ fontWeight: 700, color: "#c06000", marginBottom: "0.2rem" }}>
                          Schema drift detected
                        </div>
                        {Object.entries(drift).map(([key, value]) => (
                          <div key={key}>
                            <strong>{key}:</strong> {String(value)}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </main>
  );
};

export default WiringTestPage;
