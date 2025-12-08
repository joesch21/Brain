import React, { useEffect, useState } from "react";

// Calls /api/wiring-status and renders a debug panel listing backend checks.
const BackendDebugConsole = () => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/wiring-status", {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      setStatus(data);
    } catch (err) {
      setError(err.message || "Unknown error");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const renderChecks = () => {
    if (!status || !Array.isArray(status.checks)) return null;
    return (
      <ul style={{ listStyle: "none", paddingLeft: 0, margin: 0 }}>
        {status.checks.map((check) => (
          <li
            key={check.name}
            style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "4px 0",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              fontSize: "0.85rem",
            }}
          >
            <span>{check.name}</span>
            <span>
              <strong
                style={{
                  textTransform: "uppercase",
                  fontWeight: 600,
                }}
              >
                {check.status}
              </strong>
              {check.detail ? ` – ${check.detail}` : ""}
            </span>
          </li>
        ))}
      </ul>
    );
  };

  return (
    <section
      style={{
        marginTop: "2rem",
        backgroundColor: "#111",
        borderRadius: 4,
        border: "1px solid #555",
        color: "#f5f5f5",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          backgroundColor: "#330000",
          color: "#ffb3b3",
          padding: "0.5rem 0.75rem",
          fontWeight: 600,
          fontSize: "0.9rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>Backend Debug</span>
        <button
          type="button"
          onClick={fetchStatus}
          disabled={loading}
          style={{
            border: "none",
            borderRadius: 999,
            padding: "0.25rem 0.75rem",
            fontSize: "0.75rem",
            cursor: loading ? "default" : "pointer",
            backgroundColor: "#222",
            color: "#fff",
          }}
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </header>

      <div style={{ padding: "0.75rem" }}>
        {error && (
          <p
            style={{
              color: "#ff8080",
              margin: "0 0 0.5rem 0",
              fontSize: "0.85rem",
            }}
          >
            Error: {error}
          </p>
        )}

        {!error && !status && !loading && (
          <p style={{ margin: 0, fontSize: "0.85rem" }}>No status loaded yet.</p>
        )}

        {status && (
          <>
            <p
              style={{
                margin: "0 0 0.5rem 0",
                fontSize: "0.8rem",
                opacity: 0.8,
              }}
            >
              Environment: <strong>{status.environment}</strong> · Service: <strong>{status.service}</strong> · Time: <strong>{status.timestamp}</strong>
            </p>
            {renderChecks()}
          </>
        )}

        {loading && (
          <p style={{ margin: 0, fontSize: "0.85rem" }}>Loading wiring status…</p>
        )}
      </div>
    </section>
  );
};

export default BackendDebugConsole;
