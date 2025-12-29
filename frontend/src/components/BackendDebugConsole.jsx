import React, { useEffect, useMemo, useState } from "react";
import { fetchWiringStatus } from "../lib/apiClient";

// Calls /api/wiring-status and renders a debug panel listing backend checks.
const BackendDebugConsole = () => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const wiringOk = useMemo(() => {
    if (!status) return false;
    if (status.ok === false) return false;
    if (Array.isArray(status.checks)) {
      return status.checks.every((check) => (check.status || "").toUpperCase() === "OK");
    }
    return true;
  }, [status]);

  const fetchStatus = async () => {
    setLoading(true);
    setError(null);

    const response = await fetchWiringStatus();
    setLoading(false);

    if (response.ok) {
      setStatus(response.data || null);
      setError(null);
    } else {
      setStatus(response.data || null);
      setError(
        response.error ||
          (response.type === "network_error"
            ? "Network error when checking wiring"
            : "Unable to load wiring status")
      );
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const renderChecks = () => {
    if (!status || !Array.isArray(status.checks)) {
      return (
        <p style={{ margin: 0, fontSize: "0.85rem", opacity: 0.75 }}>
          No component checks reported.
        </p>
      );
    }
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
                  color:
                    (check.status || "").toUpperCase() === "OK"
                      ? "#7ee787"
                      : "#ffb3b3",
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

  const renderBanner = () => {
    if (loading) {
      return null;
    }
    if (error) {
      return (
        <p
          style={{
            backgroundColor: "#2a0f0f",
            border: "1px solid #b71c1c",
            color: "#ffb3b3",
            padding: "0.6rem 0.75rem",
            borderRadius: 4,
            margin: "0 0 0.75rem 0",
            fontSize: "0.9rem",
          }}
        >
          Wiring check failed: {error}
        </p>
      );
    }
    if (status) {
      return (
        <p
          style={{
            backgroundColor: wiringOk ? "#0f2414" : "#2a210f",
            border: wiringOk ? "1px solid #1b5e20" : "1px solid #8a6d1c",
            color: wiringOk ? "#7ee787" : "#f5dd92",
            padding: "0.6rem 0.75rem",
            borderRadius: 4,
            margin: "0 0 0.75rem 0",
            fontSize: "0.9rem",
          }}
        >
          {wiringOk ? "Wiring looks good" : "Wiring returned warnings – see checks below."}
        </p>
      );
    }
    return null;
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
        {renderBanner()}

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
