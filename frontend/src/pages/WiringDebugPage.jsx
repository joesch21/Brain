import React, { useEffect, useMemo, useState } from "react";
import BackendDebugConsole from "../components/BackendDebugConsole";
import { pushBackendDebugEntry } from "../lib/backendDebug";
import { apiUrl, getApiBase } from "../lib/apiBase";
import "../styles/wiringDebug.css";

const todayISO = () => new Date().toISOString().slice(0, 10);

const TESTS = [
  {
    key: "wiring-status",
    label: `GET ${apiUrl("api/wiring-status")}`,
    method: "GET",
    buildUrl: () => apiUrl("api/wiring-status"),
  },
  {
    key: "staff",
    label: `GET ${apiUrl("api/staff")}`,
    method: "GET",
    buildUrl: () => apiUrl("api/staff"),
  },
  {
    key: "flights",
    label: `GET ${apiUrl("api/flights")}?date=YYYY-MM-DD`,
    method: "GET",
    buildUrl: (date) =>
      apiUrl(`api/flights?date=${encodeURIComponent(date)}&airport=YSSY&airline=ALL`),
  },
  {
    key: "runs",
    label: `GET ${apiUrl("api/runs")}`,
    method: "GET",
    buildUrl: (date) =>
      apiUrl(`api/runs?date=${encodeURIComponent(date)}&airport=YSSY&airline=ALL`),
  },
  {
    key: "auto-assign",
    label: `POST ${apiUrl("api/runs/auto_assign")}`,
    method: "POST",
    buildUrl: () => apiUrl("api/runs/auto_assign"),
    body: (date) => ({ date, airline: "ALL" }),
  },
];

const ResponseBlock = ({ result }) => {
  if (!result) return <p className="wiring-debug__muted">No call yet.</p>;
  return (
    <div className="wiring-debug__response">
      <div className="wiring-debug__response-meta">
        <span>
          <strong>Status:</strong> {String(result.status ?? "n/a")}
        </span>
        <span>
          <strong>Method:</strong> {result.method}
        </span>
        <span className="wiring-debug__muted">{result.url}</span>
      </div>
      {result.error && (
        <div className="wiring-debug__error">
          <strong>Error:</strong> {result.error}
          {result.type ? ` (${result.type})` : ""}
        </div>
      )}
      {result.data && (
        <pre className="wiring-debug__payload">
          {JSON.stringify(result.data, null, 2)}
        </pre>
      )}
    </div>
  );
};

const WiringDebugPage = () => {
  const [date, setDate] = useState(todayISO());
  const [results, setResults] = useState({});
  const [loadingKey, setLoadingKey] = useState(null);
  const [recentEntries, setRecentEntries] = useState([]);

  const resolvedBase = useMemo(() => getApiBase(), []);
  const rawEnvBase = useMemo(
    () => import.meta?.env?.VITE_API_BASE || "",
    []
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const entries = window.backendDebug?.entries || [];
      setRecentEntries(entries.slice(-6).reverse());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  async function runTest(test) {
    const url = test.buildUrl(date);
    const method = test.method || "GET";
    const body = test.body ? test.body(date) : undefined;

    setLoadingKey(test.key);
    try {
      const resp = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body ? JSON.stringify(body) : undefined,
      });
      const status = resp.status;
      const contentType = resp.headers?.get("content-type") || "";
      let data;
      try {
        data = contentType.includes("application/json")
          ? await resp.json()
          : await resp.text();
      } catch (parseErr) {
        data = { parseError: parseErr?.message };
      }

      const ok = resp.ok && (typeof data !== "object" || data?.ok !== false);
      const entry = {
        key: test.key,
        status,
        ok,
        data,
        url,
        method,
        type: !ok ? data?.type : undefined,
        error:
          !ok && (data?.error || data?.message || resp.statusText || "Request failed"),
      };
      pushBackendDebugEntry({
        type: ok ? "http-ok" : "http-error",
        url,
        method,
        status,
        body: data,
      });
      setResults((prev) => ({ ...prev, [test.key]: entry }));
    } catch (err) {
      const entry = {
        key: test.key,
        status: null,
        ok: false,
        data: null,
        url,
        method,
        type: "network_error",
        error: err?.message || "Network error",
      };
      pushBackendDebugEntry({
        type: "network-error",
        url,
        method,
        error: entry.error,
      });
      setResults((prev) => ({ ...prev, [test.key]: entry }));
    } finally {
      setLoadingKey(null);
    }
  }

  return (
    <main className="wiring-debug">
      <header className="wiring-debug__header">
        <div>
          <p className="wiring-debug__eyebrow">Frontend Wiring Debug</p>
          <h1>Network Truth</h1>
          <p className="wiring-debug__muted">
            This page shows the exact API base the browser is using and lets you
            hit key endpoints directly. Use it to prove calls are going via Brain
            and see real responses.
          </p>
          <div className="wiring-debug__pill-row">
            <div className="wiring-debug__pill">
              <span className="wiring-debug__pill-label">Resolved API base</span>
              <code>{resolvedBase}</code>
            </div>
            <div className="wiring-debug__pill">
              <span className="wiring-debug__pill-label">VITE_API_BASE</span>
              <code>{rawEnvBase || "(empty)"}</code>
            </div>
            <div className="wiring-debug__pill">
              <span className="wiring-debug__pill-label">window.origin</span>
              <code>{typeof window !== "undefined" ? window.location.origin : "n/a"}</code>
            </div>
          </div>
        </div>
        <div className="wiring-debug__date-picker">
          <label htmlFor="wiring-date">Date</label>
          <input
            id="wiring-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
      </header>

      <section className="wiring-debug__grid">
        {TESTS.map((test) => (
          <div key={test.key} className="wiring-debug__card">
            <div className="wiring-debug__card-head">
              <div>
                <p className="wiring-debug__eyebrow">{test.method}</p>
                <h2>{test.label}</h2>
              </div>
              <button
                type="button"
                onClick={() => runTest(test)}
                disabled={loadingKey === test.key}
                className="wiring-debug__button"
              >
                {loadingKey === test.key ? "Testing…" : "Test"}
              </button>
            </div>
            <ResponseBlock result={results[test.key]} />
          </div>
        ))}
      </section>

      <section className="wiring-debug__backend-panel">
        <h3>Backend wiring status</h3>
        <p className="wiring-debug__muted">
          The panel below is the existing wiring status proxy. Use it alongside
          the tests above to confirm Brain → CC2 connectivity.
        </p>
        <BackendDebugConsole />
      </section>

      <section className="wiring-debug__backend-panel">
        <h3>Last API calls (browser)</h3>
        <p className="wiring-debug__muted">
          Entries are captured automatically from the wiring tests and other API
          errors. Use them to confirm which endpoints the browser hit and the
          status returned.
        </p>
        <div className="wiring-debug__recent-entries">
          {recentEntries.length === 0 && (
            <p className="wiring-debug__muted">No API calls captured yet.</p>
          )}
          {recentEntries.map((entry, idx) => (
            <div key={`${entry.timestamp}-${idx}`} className="wiring-debug__recent-row">
              <div>
                <div className="wiring-debug__eyebrow">{entry.method || entry.type}</div>
                <div className="wiring-debug__muted wiring-debug__recent-url">{entry.url}</div>
              </div>
              <div className="wiring-debug__recent-meta">
                {entry.status ? `HTTP ${entry.status}` : entry.error || "n/a"}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
};

export default WiringDebugPage;
