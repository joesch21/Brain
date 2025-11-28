// Machine Room page with inline system status + seed/test tools
import React, { useEffect, useState } from "react";

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

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

const SystemStatusCard = () => {
  const [date, setDate] = useState(todayISO());
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [testingApis, setTestingApis] = useState(false);
  const [apiTests, setApiTests] = useState([]);

  const [seeding, setSeeding] = useState(false);

  async function loadStatus(targetDate) {
    try {
      setLoading(true);
      setError("");
      const resp = await fetch(
        `/api/status?date=${encodeURIComponent(targetDate)}`
      );
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Status failed (${resp.status}): ${text || "Unknown error"}`
        );
      }
      const data = await resp.json();
      setStatus(data);
    } catch (err) {
      console.error(err);
      setError(err.message || "Error checking backend status.");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus(date);
  }, [date]);

  async function testCoreApis() {
    const tests = [
      {
        name: "Flights (date)",
        url: `/api/flights?date=${encodeURIComponent(date)}`,
      },
      {
        name: "Runs (date)",
        url: `/api/runs?date=${encodeURIComponent(date)}`,
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
        try {
          const resp = await fetch(t.url);
          const millis = Math.round(performance.now() - started);

          if (!resp.ok) {
            const text = await resp.text();
            results.push({
              name: t.name,
              url: t.url,
              ok: false,
              status: resp.status,
              millis,
              message: text?.slice(0, 120) || "HTTP error",
            });
          } else {
            results.push({
              name: t.name,
              url: t.url,
              ok: true,
              status: resp.status,
              millis,
              message: "OK",
            });
          }
        } catch (err) {
          const millis = Math.round(performance.now() - started);
          results.push({
            name: t.name,
            url: t.url,
            ok: false,
            status: "NETWORK",
            millis,
            message: (err && err.message) || "Network error",
          });
        }
      }

      setApiTests(results);
    } finally {
      setTestingApis(false);
    }
  }

  async function seedDemoFlights() {
    const payload = {
      date,
      flights: [
        {
          flight_number: "JQ719",
          destination: "HBA",
          time_local: "06:00",
          operator_code: "AJ",
          aircraft_type: "A320",
          notes: "",
        },
        {
          flight_number: "JQ603",
          destination: "AVV",
          time_local: "06:00",
          operator_code: "RB",
          aircraft_type: "A320",
          notes: "",
        },
        {
          flight_number: "JQ400",
          destination: "OOL",
          time_local: "06:10",
          operator_code: "EG",
          aircraft_type: "A320",
          notes: "",
        },
      ],
    };

    try {
      setSeeding(true);
      setError("");

      const resp = await fetch("/api/flights/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

  const flights = status?.flights || {
    total: 0,
    am_total: 0,
    pm_total: 0,
    by_airline: {},
  };
  const runs = status?.runs || {
    total: 0,
    with_flights: 0,
    unassigned_flights: 0,
  };

  const byAirlineEntries = Object.entries(flights.by_airline || {}).sort(
    ([a], [b]) => a.localeCompare(b)
  );

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
          <button
            type="button"
            onClick={testCoreApis}
            disabled={testingApis || seeding}
            style={{ fontSize: "0.8rem", marginRight: "0.5rem" }}
          >
            {testingApis ? "Testing APIs…" : "Test core APIs"}
          </button>
          <button
            type="button"
            onClick={seedDemoFlights}
            disabled={seeding || testingApis}
            style={{ fontSize: "0.8rem" }}
          >
            {seeding ? "Seeding…" : "Seed demo flights"}
          </button>
        </div>
      </div>

      {loading && <p>Checking backend…</p>}
      {error && <p style={{ color: "#ff8a80" }}>{error}</p>}

      {!loading && !error && status && (
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
              <h4>Flights ({status.date})</h4>
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
  return (
    <div className="machine-room-page">
      <h2>Machine Room</h2>
      <p>Quick system snapshot for supervisors and admins.</p>

      {/* NEW: live system status, flight/run counts, API tests, and seeding */}
      <SystemStatusCard />

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
