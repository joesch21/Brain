import React, { useState } from "react";

import { API_BASE } from "../api/apiBase";
import { apiRequest } from "../lib/apiClient";

const WiringTestPanel = () => {
  const apiBase =
    (import.meta?.env?.VITE_API_BASE ?? "").toString().trim() || API_BASE;

  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleTest = async () => {
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const { data } = await apiRequest("/api/ops/debug/wiring", {
        method: "GET",
      });
      setResult(data);
    } catch (err) {
      setError(err.message || "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ border: "1px solid #ccc", padding: "1rem", borderRadius: 8 }}>
      <h2>Wiring Test (Brain → CodeCrafter2)</h2>

      <p>
        <strong>Backend URL (VITE_API_BASE_URL):</strong> {apiBase}
      </p>

      <button onClick={handleTest} disabled={loading}>
        {loading ? "Testing..." : "Run Wiring Test"}
      </button>

      {error && (
        <p style={{ color: "red", marginTop: "0.75rem", whiteSpace: "pre-wrap" }}>
          <strong>Error:</strong> {error}
        </p>
      )}

      {result && (
        <div style={{ marginTop: "1rem" }}>
          <p>
            <strong>Service:</strong> {result.service}
          </p>
          <p>
            <strong>OK:</strong> {String(result.ok)}
          </p>

          {result.env && (
            <div style={{ marginTop: "0.5rem" }}>
              <strong>Environment:</strong>
              <ul>
                <li>
                  DATABASE_URL_present: {String(result.env.DATABASE_URL_present)}
                </li>
                <li>OPS_DATA_MODE: {result.env.OPS_DATA_MODE}</li>
                <li>OFFICE_DB_MODE: {result.env.OFFICE_DB_MODE}</li>
                <li>OPS_API_BASE_URL: {result.env.OPS_API_BASE_URL}</li>
              </ul>
            </div>
          )}

          {Array.isArray(result.problems) && result.problems.length > 0 && (
            <div style={{ marginTop: "0.5rem" }}>
              <strong>Problems:</strong>
              <ul>
                {result.problems.map((p, idx) => (
                  <li key={idx}>{p}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default WiringTestPanel;
