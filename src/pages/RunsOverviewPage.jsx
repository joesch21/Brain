import React, { useEffect, useState } from "react";
import { autoAssignRuns, fetchDailyRuns } from "../api/runsApi";
import { fetchRosterOperators } from "../api/rosterApi";

function getTodayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const RunsOverviewPage = () => {
  const [date, setDate] = useState(getTodayISO());
  const [operator, setOperator] = useState("ALL");
  const [runs, setRuns] = useState([]);
  const [runsMessage, setRunsMessage] = useState("");
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [autoAssignLoading, setAutoAssignLoading] = useState(false);
  const [error, setError] = useState(null);
  const [unassignedFlights, setUnassignedFlights] = useState([]);
  const [unassignedMessage, setUnassignedMessage] = useState("");
  const [operatorOptions, setOperatorOptions] = useState(["ALL"]);
  const [operatorLoading, setOperatorLoading] = useState(false);
  const [operatorError, setOperatorError] = useState(null);

  const loadRuns = async (selectedDate = date, selectedOperator = operator) => {
    setLoadingRuns(true);
    setError(null);

    try {
      const data = await fetchDailyRuns(selectedDate, selectedOperator);
      setRuns(data?.runs || []);
      setRunsMessage(data?.message || "");
    } catch (err) {
      setError(err.message || "Failed to load runs.");
      setRuns([]);
      setRunsMessage("");
    } finally {
      setLoadingRuns(false);
    }
  };

  const loadUnassignedFlights = async () => {
    setUnassignedFlights([]);
    setUnassignedMessage("Unassigned flights stub – plug in real data.");
  };

  useEffect(() => {
    const loadOperators = async () => {
      setOperatorLoading(true);
      setOperatorError(null);

      try {
        const ops = await fetchRosterOperators(date);
        const withAll = ["ALL", ...ops.filter((op) => op !== "ALL")];
        setOperatorOptions(withAll);

        if (!withAll.includes(operator)) {
          setOperator("ALL");
        }
      } catch (err) {
        setOperatorError(err.message || "Failed to load roster operators.");
        setOperatorOptions(["ALL"]);
        setOperator("ALL");
      } finally {
        setOperatorLoading(false);
      }
    };

    loadOperators();
  }, [date]);

  useEffect(() => {
    loadRuns(date, operator);
    loadUnassignedFlights();
  }, [date, operator]);

  const handleAutoAssign = async () => {
    setAutoAssignLoading(true);
    setError(null);
    try {
      const data = await autoAssignRuns(date, operator);
      setRuns(data?.runs || []);
      setRunsMessage(data?.message || "");
      await loadUnassignedFlights();
    } catch (err) {
      setError(err.message || "Auto-assign failed.");
    } finally {
      setAutoAssignLoading(false);
    }
  };

  return (
    <main style={{ padding: "1.5rem" }}>
      <h1>Runs Overview</h1>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
          alignItems: "center",
          marginBottom: "1rem",
        }}
      >
        <div>
          <label
            htmlFor="runs-date"
            style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.25rem" }}
          >
            Date
          </label>
          <input
            id="runs-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: 4,
              border: "1px solid #444",
              backgroundColor: "#111",
              color: "#fff",
            }}
          />
        </div>

        <div>
          <label
            htmlFor="runs-operator"
            style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.25rem" }}
          >
            Operator
          </label>
          <select
            id="runs-operator"
            value={operator}
            onChange={(e) => setOperator(e.target.value)}
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: 4,
              border: "1px solid #444",
              backgroundColor: "#111",
              color: "#fff",
            }}
          >
            {operatorOptions.map((op) => (
              <option key={op} value={op}>
                {op === "ALL" ? "All operators" : op}
              </option>
            ))}
          </select>
          {operatorLoading && (
            <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", opacity: 0.7 }}>
              Loading roster…
            </span>
          )}
          {operatorError && (
            <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "#ff8080" }}>
              {operatorError}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={handleAutoAssign}
          disabled={autoAssignLoading}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: 999,
            border: "none",
            cursor: autoAssignLoading ? "default" : "pointer",
            backgroundColor: "#0f9d58",
            color: "#fff",
            fontWeight: 600,
          }}
        >
          {autoAssignLoading ? "Auto-assigning…" : "Auto-assign runs for this day"}
        </button>

        <button
          type="button"
          onClick={() => loadRuns()}
          disabled={loadingRuns}
          style={{
            padding: "0.5rem 1rem",
            borderRadius: 999,
            border: "1px solid #444",
            cursor: loadingRuns ? "default" : "pointer",
            backgroundColor: "#111",
            color: "#fff",
            fontWeight: 500,
          }}
        >
          {loadingRuns ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {error && (
        <p style={{ color: "#ff8080", fontSize: "0.9rem", marginBottom: "0.75rem" }}>
          Error: {error}
        </p>
      )}

      {runsMessage && (
        <p style={{ fontSize: "0.85rem", opacity: 0.8, marginBottom: "0.75rem" }}>
          {runsMessage}
        </p>
      )}

      <section style={{ marginBottom: "2rem" }}>
        <h2>Runs</h2>
        {runs.length === 0 ? (
          <p style={{ fontSize: "0.9rem" }}>No runs for this date/operator.</p>
        ) : (
          runs.map((run) => (
            <div
              key={run.id}
              style={{
                border: "1px solid #444",
                borderRadius: 4,
                padding: "0.75rem",
                marginBottom: "0.75rem",
                backgroundColor: "#121212",
              }}
            >
              <h3 style={{ margin: "0 0 0.5rem 0" }}>{run.name}</h3>
              {run.flights && run.flights.length > 0 ? (
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: "0.85rem",
                  }}
                >
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>Time</th>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>Flight</th>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>Dest</th>
                      <th style={{ textAlign: "left", padding: "4px 6px" }}>Operator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.flights.map((f) => (
                      <tr key={f.flight_id || f.id}>
                        <td style={{ padding: "4px 6px" }}>{f.time}</td>
                        <td style={{ padding: "4px 6px" }}>{f.flight_id || f.flight_number}</td>
                        <td style={{ padding: "4px 6px" }}>{f.dest || f.destination || "-"}</td>
                        <td style={{ padding: "4px 6px" }}>{f.operator}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p style={{ fontSize: "0.85rem" }}>No flights in this run yet.</p>
              )}
            </div>
          ))
        )}
      </section>

      <section>
        <h2>Unassigned flights</h2>
        <p style={{ fontSize: "0.85rem" }}>{unassignedMessage}</p>
        {unassignedFlights.length > 0 && (
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.85rem",
            }}
          >
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>Time</th>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>Flight</th>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>Dest</th>
                <th style={{ textAlign: "left", padding: "4px 6px" }}>Operator</th>
              </tr>
            </thead>
            <tbody>
              {unassignedFlights.map((f) => (
                <tr key={f.flight_id || f.id}>
                  <td style={{ padding: "4px 6px" }}>{f.time}</td>
                  <td style={{ padding: "4px 6px" }}>{f.flight_id || f.flight_number}</td>
                  <td style={{ padding: "4px 6px" }}>{f.dest || f.destination || "-"}</td>
                  <td style={{ padding: "4px 6px" }}>{f.operator}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
};

export default RunsOverviewPage;
