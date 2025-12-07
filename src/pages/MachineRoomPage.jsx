// Machine Room page with inline system status + seed/test tools
import React, { useEffect, useState } from "react";
import { fetchApiStatus, formatApiError } from "../utils/apiStatus";
import ImportStatusCard from "../components/ImportStatusCard";
import { pushBackendDebugEntry } from "../lib/backendDebug";
import "../styles/machineRoom.css";

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const AIRLINE_OPTIONS = ["JQ", "QF", "VA", "ZL"];
const ALL_AIRLINE_OPTION = "ALL";
const DEFAULT_AIRLINE = "JQ";

const WIRING_TESTS = [
  {
    key: "status",
    label: "System status",
    method: "GET",
    buildUrl: () => "/api/status",
    expectsOkField: false,
  },
  {
    key: "flights",
    label: "Flights for date",
    method: "GET",
    buildUrl: (date) => `/api/flights?date=${encodeURIComponent(date)}`,
    expectsOkField: true,
  },
  {
    key: "roster",
    label: "Roster for date",
    method: "GET",
    buildUrl: (date) => `/api/roster/daily?date=${encodeURIComponent(date)}`,
    expectsOkField: true,
  },
  {
    key: "assignments",
    label: "Employee assignments for date",
    method: "GET",
    buildUrl: (date) =>
      `/api/employee_assignments/daily?date=${encodeURIComponent(date)}`,
    expectsOkField: true,
  },
  {
    key: "runs",
    label: "Runs for date",
    method: "GET",
    buildUrl: (date) => `/api/runs?date=${encodeURIComponent(date)}`,
    expectsOkField: true,
  },
];

const StatusPill = ({ ok, label }) => (
  <span
    style={{
      display: "inline-block",
      padding: "0.1rem 0.55rem",
      borderRadius: "999px",
      fontSize: "0.75rem",
      backgroundColor: ok ? "#e8f5e9" : "#ffebee",
      color: ok ? "#1b5e20" : "#b71c1c",
      marginLeft: "0.5rem",
    }}
  >
    {label}
  </span>
);

const SystemStatusCard = ({ selectedAirline }) => {
  const [date, setDate] = useState(todayISO());
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [roster, setRoster] = useState([]);
  const [staffRuns, setStaffRuns] = useState({ runs: [], unassigned: [] });
  const [runsStatus, setRunsStatus] = useState(null);
  const [runsStatusError, setRunsStatusError] = useState("");
  const [staffingError, setStaffingError] = useState("");

  const [wiringRunning, setWiringRunning] = useState(false);
  const [wiringResults, setWiringResults] = useState([]);
  const [wiringError, setWiringError] = useState(null);

  const [testingApis, setTestingApis] = useState(false);
  const [apiTests, setApiTests] = useState([]);

  const [seeding, setSeeding] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [assignmentMessage, setAssignmentMessage] = useState("");
  const [prepareLoading, setPrepareLoading] = useState(false);
  const [prepareStatus, setPrepareStatus] = useState(null);
  const [rosterSeedLoading, setRosterSeedLoading] = useState(false);
  const [rosterSeedStatus, setRosterSeedStatus] = useState(null);

  async function loadStatus(targetDate) {
    try {
      setLoading(true);
      setError("");
      setStaffingError("");
      setRunsStatus(null);
      setRunsStatusError("");
      const airlineSuffix =
        selectedAirline && selectedAirline !== ALL_AIRLINE_OPTION
          ? `&airline=${encodeURIComponent(selectedAirline)}`
          : "";
      const resp = await fetchApiStatus(
        `/api/status?date=${encodeURIComponent(targetDate)}${airlineSuffix}`
      );

      if (!resp.ok) {
        throw new Error(formatApiError("Status", resp));
      }

      const data = resp.data || {};
      setStatus(data);

      if (data.ok === false || data.database_ok === false) {
        setError(
          "Scheduling backend unavailable – check Code_Crafter2 / database."
        );
      }

      const rosterResp = await fetchApiStatus(
        `/api/roster/daily?date=${encodeURIComponent(targetDate)}`
      );
      if (rosterResp.ok) {
        const shifts =
          rosterResp.data?.roster?.shifts || rosterResp.data?.shifts || [];
        setRoster(Array.isArray(shifts) ? shifts : []);
      } else {
        setRoster([]);
        setStaffingError(formatApiError("Roster", rosterResp));
      }

      const staffAirline =
        selectedAirline && selectedAirline !== ALL_AIRLINE_OPTION
          ? selectedAirline
          : DEFAULT_AIRLINE;
      const staffRunsResp = await fetchApiStatus(
        `/api/staff_runs?date=${encodeURIComponent(targetDate)}&airline=${encodeURIComponent(
          staffAirline
        )}`
      );
      if (staffRunsResp.ok) {
        const runsPayload = staffRunsResp.data || {};
        setStaffRuns({
          runs: Array.isArray(runsPayload.runs) ? runsPayload.runs : [],
          unassigned: Array.isArray(runsPayload.unassigned)
            ? runsPayload.unassigned
            : [],
        });
      } else {
        setStaffRuns({ runs: [], unassigned: [] });
        setStaffingError(formatApiError("Staff runs", staffRunsResp));
      }

      const runsStatusResp = await fetchApiStatus(
        `/api/runs_status?date=${encodeURIComponent(targetDate)}`
      );
      if (runsStatusResp.ok) {
        setRunsStatus(runsStatusResp.data || null);
      } else {
        setRunsStatus(null);
        setRunsStatusError(formatApiError("Runs status", runsStatusResp));
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "Error checking backend status.");
      setStatus(null);
      setRoster([]);
      setStaffRuns({ runs: [], unassigned: [] });
      setRunsStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus(date);
  }, [date, selectedAirline]);

  async function testCoreApis() {
    const airlineSuffix =
      selectedAirline && selectedAirline !== ALL_AIRLINE_OPTION
        ? `&airline=${encodeURIComponent(selectedAirline)}`
        : "";

    const tests = [
      {
        name: "Flights (date)",
        url: `/api/flights?date=${encodeURIComponent(date)}${airlineSuffix}`,
      },
      {
        name: "Runs (date)",
        url: `/api/runs?date=${encodeURIComponent(date)}${airlineSuffix}`,
      },
      {
        name: "Roster (date)",
        url: `/api/roster/daily?date=${encodeURIComponent(date)}`,
      },
      {
        name: "Staff runs (date)",
        url: `/api/staff_runs?date=${encodeURIComponent(date)}${airlineSuffix || `&airline=${DEFAULT_AIRLINE}`}`,
      },
      {
        name: "Runs status (date)",
        url: `/api/runs_status?date=${encodeURIComponent(date)}`,
      },
      {
        name: "Service profiles",
        url: `/api/service_profiles`,
      },
    ];

    setTestingApis(true);
    setApiTests([]);

    try {
      const results = [];

      for (const t of tests) {
        const started = performance.now();
        const resp = await fetchApiStatus(t.url);
        const millis = Math.round(performance.now() - started);

        results.push({
          name: t.name,
          url: t.url,
          ok: resp.ok,
          status: resp.ok ? resp.status : resp.status || "NETWORK",
          millis,
          message: resp.ok ? "OK" : resp.error || "Request failed",
        });
      }

      setApiTests(results);
    } finally {
      setTestingApis(false);
    }
  }

  const handleLoadDec24Roster = async () => {
    setRosterSeedLoading(true);
    setRosterSeedStatus(null);
    try {
      const resp = await fetch("/api/roster/load_seed", { method: "POST" });
      const body = await resp.json();
      if (!resp.ok || body.ok === false) {
        setRosterSeedStatus({
          ok: false,
          message: body.error || "Failed to load DEC24 roster seed.",
        });
      } else {
        setRosterSeedStatus({
          ok: true,
          message: `DEC24 roster seed loaded (template ${body.template_name}).`,
        });
      }
    } catch (err) {
      setRosterSeedStatus({
        ok: false,
        message:
          err?.message || "Network error while loading DEC24 roster seed.",
      });
    } finally {
      setRosterSeedLoading(false);
    }
  };

  const runWiringTest = async () => {
    const dateStr = date || todayISO();

    setWiringRunning(true);
    setWiringResults([]);
    setWiringError(null);

    const results = [];

    for (const test of WIRING_TESTS) {
      const url = test.buildUrl(dateStr);
      const result = {
        key: test.key,
        label: test.label,
        url,
        status: "pending",
        httpStatus: null,
        message: "",
      };

      try {
        const resp = await fetch(url, {
          method: test.method,
          credentials: "include",
        });
        const httpStatus = resp.status;
        result.httpStatus = httpStatus;

        let body = null;
        try {
          body = await resp.json();
        } catch (jsonErr) {
          console.debug("Wiring test non-JSON body", jsonErr);
        }

        const baseOk = resp.ok;
        const logicalOk = test.expectsOkField ? body?.ok !== false : true;

        if (baseOk && logicalOk) {
          result.status = "ok";
          if (body && typeof body === "object") {
            const extra =
              body.count != null
                ? `count=${body.count}`
                : body.summary
                ? "summary returned"
                : "";
            result.message = extra || "OK";
          } else {
            result.message = "OK";
          }
        } else if (baseOk && !logicalOk) {
          result.status = "warn";
          result.message = body?.error || body?.message || "ok=false in body";
        } else {
          result.status = "error";
          result.message = body?.error || body?.message || `HTTP ${httpStatus}`;
        }

        pushBackendDebugEntry({
          type: "wiring-test",
          testKey: test.key,
          label: test.label,
          url,
          httpStatus,
          status: result.status,
          message: result.message,
          body,
        });
      } catch (err) {
        result.status = "error";
        result.httpStatus = null;
        result.message = err?.message || "Network error";

        pushBackendDebugEntry({
          type: "wiring-test",
          testKey: test.key,
          label: test.label,
          url,
          status: "error",
          message: result.message,
        });
      }

      results.push(result);
      setWiringResults((prev) => [...prev, result]);
    }

    setWiringRunning(false);
    setWiringResults(results);
  };

  async function seedDemoFlights() {
    try {
      setSeeding(true);
      setError("");
      setAssignmentMessage("");

      const url = date
        ? `/api/dev/seed_dec24_schedule?date=${encodeURIComponent(date)}`
        : "/api/dev/seed_dec24_schedule";
      const resp = await fetch(url, {
        method: "POST",
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Seed demo flights failed (${resp.status}): ${
            text || "Unknown error"
          }`
        );
      }

      await loadStatus(date);
    } catch (err) {
      console.error(err);
      setError(err.message || "Error seeding demo flights.");
    } finally {
      setSeeding(false);
    }
  }

  const handlePrepareOpsDay = async () => {
    setPrepareStatus(null);
    setPrepareLoading(true);

    const params = new URLSearchParams({
      date,
    });

    try {
      const resp = await fetch(`/api/ops/prepare_day?${params.toString()}`, {
        method: "POST",
      });
      const body = await resp.json().catch(() => ({}));
      const ok = resp.ok && body?.ok !== false;

      if (!ok) {
        setPrepareStatus({
          ok: false,
          message: body?.error || "Ops day preparation failed.",
          summary: body?.summary || null,
        });
        return;
      }

      setPrepareStatus({
        ok: true,
        message: `Ops day prepared for ${body.date || date}.`,
        summary: body?.summary || null,
      });

      await loadStatus(body?.date || date);
    } catch (err) {
      setPrepareStatus({
        ok: false,
        message: err?.message || "Network error preparing ops day.",
        summary: null,
      });
    } finally {
      setPrepareLoading(false);
    }
  };

  async function autoAssignEmployees() {
    const targetAirline =
      selectedAirline && selectedAirline !== ALL_AIRLINE_OPTION
        ? selectedAirline
        : DEFAULT_AIRLINE;

    try {
      setAssigning(true);
      setAssignmentMessage("");
      const resp = await fetch("/api/employee_assignments/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, airline: targetAirline }),
      });

      const body = await resp.json();
      if (!resp.ok || body?.ok === false) {
        throw new Error(body?.error || "Failed to auto-assign employees.");
      }

      setAssignmentMessage(
        `Assigned ${body.assigned ?? 0}/${body.total_flights ?? 0} flights for ${
          body.airline || targetAirline
        } on ${body.date || date}.`
      );
      await loadStatus(date);
    } catch (err) {
      console.error(err);
      setAssignmentMessage(err?.message || "Failed to auto-assign employees.");
    } finally {
      setAssigning(false);
    }
  }

  const flights = status?.flights || {
    total: 0,
    am_total: 0,
    pm_total: 0,
    assigned: 0,
    unassigned: 0,
    by_airline: {},
  };
  const runsHealth = Array.isArray(runsStatus?.airlines)
    ? runsStatus.airlines
    : [];
  const runs = status?.runs || {
    total: 0,
    with_flights: 0,
    unassigned_flights: 0,
  };

  const rosteredCount = Array.isArray(roster) ? roster.length : 0;
  const staffAssignedFlights = (staffRuns.runs || []).reduce(
    (acc, run) => acc + (Array.isArray(run.jobs) ? run.jobs.length : 0),
    0
  );
  const staffUnassignedFlights = (staffRuns.unassigned || []).length;

  const byAirlineEntries = Object.entries(flights.by_airline || {}).sort(
    ([a], [b]) => a.localeCompare(b)
  );

  const airlineLabel =
    selectedAirline && selectedAirline !== ALL_AIRLINE_OPTION
      ? selectedAirline
      : "All airlines";

  const renderWiringPanel = () => {
    const dateStr = date || todayISO();

    return (
      <section className="wiring-panel">
        <div className="wiring-panel__header">
          <h4 style={{ margin: 0 }}>Wiring Test</h4>
          <span className="wiring-panel__subtitle">
            Check backend endpoints for {dateStr}
          </span>
        </div>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={runWiringTest}
          disabled={wiringRunning}
          style={{ padding: "0.35rem 0.6rem" }}
        >
          {wiringRunning ? "Running wiring test…" : "Run wiring test"}
        </button>

        {wiringError && <div className="wiring-panel__error">{wiringError}</div>}

        <ul className="wiring-panel__list">
          {wiringResults.map((r) => (
            <li key={r.key} className="wiring-panel__item">
              <span className="wiring-panel__icon">
                {r.status === "ok" && "✅"}
                {r.status === "warn" && "⚠️"}
                {r.status === "error" && "❌"}
                {r.status === "pending" && "…"}
              </span>
              <span className="wiring-panel__label">{r.label}</span>
              <span className="wiring-panel__status">
                {r.httpStatus != null ? `HTTP ${r.httpStatus}` : ""}
                {r.message && ` – ${r.message}`}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  };

  return (
    <div className="machine-room-status-card" style={{ marginTop: "1rem" }}>
      <div
        className="machine-room-status-header"
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "0.5rem",
        }}
      >
        <div>
          <h3>System status</h3>
          <small>
            Backend health &amp; daily flight stats
            {status && (
              <span style={{ marginLeft: "0.4rem", fontSize: "0.7rem" }}>
                {status.timestamp}
              </span>
            )}
          </small>
        </div>
        <div>
          <label style={{ fontSize: "0.8rem", marginRight: "0.75rem" }}>
            Date:{" "}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
      </div>
      <div className="system-actions">
        <button
          type="button"
          className="pill-button"
          onClick={testCoreApis}
          disabled={testingApis || seeding}
        >
          {testingApis ? "Testing APIs…" : "Test core APIs"}
        </button>
        <button
          type="button"
          className="pill-button"
          onClick={seedDemoFlights}
          disabled={seeding || testingApis}
        >
          {seeding ? "Seeding…" : "Seed demo flights"}
        </button>
        <button
          type="button"
          className="pill-button"
          onClick={autoAssignEmployees}
          disabled={assigning}
        >
          {assigning ? "Assigning…" : "Auto-assign employees"}
        </button>
        <button
          type="button"
          className="pill-button"
          onClick={handlePrepareOpsDay}
          disabled={prepareLoading}
        >
          {prepareLoading ? "Preparing ops day…" : "Prepare ops day"}
        </button>
        <button
          type="button"
          className="pill-button"
          onClick={handleLoadDec24Roster}
          disabled={rosterSeedLoading}
        >
          {rosterSeedLoading ? "Loading DEC24 roster…" : "Load DEC24 roster"}
        </button>
      </div>
      {rosterSeedStatus && (
        <div
          className={
            "roster-seed-banner " +
            (rosterSeedStatus.ok
              ? "roster-seed-banner--ok"
              : "roster-seed-banner--error")
          }
        >
          {rosterSeedStatus.message}
        </div>
      )}
      {renderWiringPanel()}
      {assignmentMessage && (
        <p className="muted" style={{ marginTop: "0.35rem" }}>
          {assignmentMessage}
        </p>
      )}
      {prepareStatus && (
        <div
          className={`opsday-status ${
            prepareStatus.ok ? "opsday-status--ok" : "opsday-status--error"
          }`}
        >
          {prepareStatus.message}
          {prepareStatus.summary && (
            <pre className="opsday-summary">
              {JSON.stringify(prepareStatus.summary, null, 2)}
            </pre>
          )}
        </div>
      )}

      {loading && <p>Checking backend…</p>}
      {error && <p style={{ color: "#ff8a80" }}>{error}</p>}

      {!loading && status && (
        <>
          <div style={{ marginBottom: "0.5rem" }}>
            <strong>Backend:</strong>
            <StatusPill ok={status.ok} label={status.ok ? "OK" : "ERROR"} />
            <strong style={{ marginLeft: "0.75rem" }}>Database:</strong>
            <StatusPill
              ok={status.database_ok}
              label={status.database_ok ? "OK" : "ERROR"}
            />
          </div>

          <div
            className="machine-room-status-grid"
            style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}
          >
            <div className="machine-room-status-col" style={{ minWidth: 180 }}>
              <h4>Flights ({status.date}, {airlineLabel})</h4>
              <p>
                <strong>Total:</strong> {flights.total}
              </p>
              <p>
                <strong>AM (05:00–12:00):</strong> {flights.am_total}
              </p>
              <p>
                <strong>PM (12:01–23:00):</strong> {flights.pm_total}
              </p>
              <p>
                <strong>Assigned to flights:</strong> {flights.assigned}
              </p>
              <p>
                <strong>Unassigned flights:</strong> {flights.unassigned}
              </p>
              <p>
                <strong>By airline:</strong>
              </p>
              {byAirlineEntries.length ? (
                <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                  {byAirlineEntries.map(([code, count]) => (
                    <li key={code}>
                      {code}: {count}
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ fontStyle: "italic" }}>No flights in database.</p>
              )}
            </div>

            <div className="machine-room-status-col" style={{ minWidth: 180 }}>
              <h4>Runs ({status.date})</h4>
              <p>
                <strong>Total runs:</strong> {runs.total}
              </p>
              <p>
                <strong>Runs with flights:</strong> {runs.with_flights}
              </p>
              <p>
                <strong>Unassigned flights:</strong> {runs.unassigned_flights}
              </p>
              <p style={{ fontSize: "0.8rem", marginTop: "0.75rem" }}>
                If flights &gt; 0 but runs = 0 or unassigned &gt; 0, try{" "}
                <strong>“Auto-assign runs for this day”</strong> on Runs
                Overview or Planner.
              </p>
            </div>

            <div className="machine-room-status-col" style={{ minWidth: 240 }}>
              <h4>Runs health ({status.date})</h4>
              {runsStatusError && (
                <p style={{ color: "#b71c1c" }}>{runsStatusError}</p>
              )}
              {!runsStatusError && runsHealth.length === 0 && (
                <p className="muted" style={{ marginBottom: 0 }}>
                  No runs generated yet.
                </p>
              )}
              {!runsStatusError && runsHealth.length > 0 && (
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "0.85rem",
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", paddingBottom: "0.35rem" }}>
                        Airline
                      </th>
                      <th style={{ textAlign: "right", paddingBottom: "0.35rem" }}>
                        Flights
                      </th>
                      <th style={{ textAlign: "right", paddingBottom: "0.35rem" }}>
                        Runs
                      </th>
                      <th style={{ textAlign: "right", paddingBottom: "0.35rem" }}>
                        Jobs
                      </th>
                      <th style={{ textAlign: "right", paddingBottom: "0.35rem" }}>
                        Unassigned
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {runsHealth.map((row) => (
                      <tr key={row.airline}>
                        <td style={{ padding: "0.15rem 0" }}>{row.airline}</td>
                        <td style={{ textAlign: "right" }}>{row.flights}</td>
                        <td style={{ textAlign: "right" }}>{row.runs}</td>
                        <td style={{ textAlign: "right" }}>{row.jobs}</td>
                        <td style={{ textAlign: "right" }}>{row.unassigned}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="machine-room-status-col" style={{ minWidth: 220 }}>
              <h4>Staffing snapshot ({status.date})</h4>
              <p>
                <strong>Rostered staff:</strong> {rosteredCount}
              </p>
              <p>
                <strong>Flights assigned:</strong> {staffAssignedFlights}
              </p>
              <p>
                <strong>Unassigned flights:</strong> {staffUnassignedFlights}
              </p>
              {staffingError && (
                <p style={{ color: "#b71c1c" }}>{staffingError}</p>
              )}
              {staffUnassignedFlights > 0 && !staffingError && (
                <p style={{ fontSize: "0.85rem", color: "#b26a00" }}>
                  {staffUnassignedFlights} flights unassigned today. <a href="/planner">Review in Planner.</a>
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {apiTests.length > 0 && (
        <div style={{ marginTop: "0.75rem" }}>
          <h4>Core API checks</h4>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.8rem",
            }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.2rem" }}>API</th>
                <th style={{ textAlign: "left", padding: "0.2rem" }}>Status</th>
                <th style={{ textAlign: "right", padding: "0.2rem" }}>ms</th>
                <th style={{ textAlign: "left", padding: "0.2rem" }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {apiTests.map((t) => (
                <tr key={t.name}>
                  <td style={{ padding: "0.2rem" }}>{t.name}</td>
                  <td style={{ padding: "0.2rem" }}>
                    <StatusPill
                      ok={t.ok}
                      label={
                        t.ok
                          ? `OK (${t.status})`
                          : `ERR (${t.status || "?"})`
                      }
                    />
                  </td>
                  <td style={{ padding: "0.2rem", textAlign: "right" }}>
                    {t.millis}
                  </td>
                  <td style={{ padding: "0.2rem" }}>
                    {t.message && t.message.length > 100
                      ? t.message.slice(0, 100) + "…"
                      : t.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const MachineRoomPage = () => {
  const [airline, setAirline] = useState(DEFAULT_AIRLINE);
  const [importLoading, setImportLoading] = useState(false);
  const [importStatus, setImportStatus] = useState(null);

  const importDisabled = importLoading || airline === ALL_AIRLINE_OPTION;

  const handleImport = async () => {
    if (airline === ALL_AIRLINE_OPTION) {
      setImportStatus({
        ok: false,
        message: "Select a specific airline to run a live import.",
        summary: null,
      });
      return;
    }

    setImportLoading(true);
    setImportStatus(null);

    try {
      const resp = await fetch(
        `/api/import/live?airline=${encodeURIComponent(airline)}`,
        { method: "POST" }
      );
      const body = await resp.json();
      const ok = resp.ok && body?.ok !== false;
      const summary = body.summary || null;

      if (ok) {
        setImportStatus({
          ok: true,
          message: `Imported ${airline} flights for upcoming days.`,
          summary,
        });
      } else {
        setImportStatus({
          ok: false,
          message:
            body?.error ||
            "Import failed. Check the scheduling backend for details.",
          summary,
        });
      }
    } catch (err) {
      setImportStatus({
        ok: false,
        message: err?.message || "Network error triggering import.",
        summary: null,
      });
    } finally {
      setImportLoading(false);
    }
  };

  const renderImportSummary = () => {
    if (!importStatus?.summary?.days || !Array.isArray(importStatus.summary.days)) {
      return null;
    }

    return (
      <div className="jq-import-summary">
        {importStatus.summary.days.map((day) => (
          <div key={day.date} className="jq-import-summary__day">
            <strong>{day.date}</strong>: {" "}
            {day.ok
              ? `OK — found ${day.found}, upserted ${day.upserted}`
              : `ERROR — ${day.error || "Unknown error"}`}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="machine-room-page">
      <h2>Machine Room</h2>
      <p>Quick system snapshot for supervisors and admins.</p>

      <ImportStatusCard />

      <div className="machine-room-card machine-room-import-card">
        <div className="machine-room-import-card__header">
          <div>
            <h3>Live import (SYD domestic)</h3>
            <p className="machine-room-intro muted">
              Trigger CodeCrafter2 to scrape flights for today and the next two
              days. Default airline is Jetstar.
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <label style={{ fontSize: "0.9rem" }}>
              Airline:{" "}
              <select
                value={airline}
                onChange={(e) => setAirline(e.target.value)}
                style={{ marginLeft: "0.35rem" }}
              >
                {AIRLINE_OPTIONS.map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
                <option value={ALL_AIRLINE_OPTION}>All</option>
              </select>
            </label>
            <button
              type="button"
              className="machine-room-import-button"
              onClick={handleImport}
              disabled={importDisabled}
              title={
                airline === ALL_AIRLINE_OPTION
                  ? "Select an airline to run an import"
                  : undefined
              }
            >
              {importLoading
                ? "Importing…"
                : `Import ${airline === ALL_AIRLINE_OPTION ? "flights" : `${airline} flights`} (3 days)`}
            </button>
          </div>
        </div>

        {importStatus && (
          <div
            className={
              "jq-import-status " +
              (importStatus.ok ? "jq-import-status--ok" : "jq-import-status--error")
            }
          >
            <div>{importStatus.message}</div>
            {renderImportSummary()}
          </div>
        )}
      </div>

      {/* NEW: live system status, flight/run counts, API tests, and seeding */}
      <SystemStatusCard selectedAirline={airline} />

      {/* Existing descriptive content can be kept below or simplified */}
      <section style={{ marginTop: "1.5rem" }}>
        <div className="card">
          <h3>Project</h3>
          <p>
            <strong>Name:</strong> The Brain
          </p>
          <p>
            <strong>Status:</strong> operational
          </p>
          <p>
            Flask-based control center for Build, Fix, and Know flows with an
            office manager demo dataset.
          </p>
          <h4>Primary flows</h4>
          <ul>
            <li>
              <strong>Build:</strong> plan and generate implementation tasks via
              the Build orchestrator
            </li>
            <li>
              <strong>Fix:</strong> review and apply automated fixes with the
              Fix service
            </li>
            <li>
              <strong>Know:</strong> answer operational questions through the
              Knowledge service
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
};

export default MachineRoomPage;
