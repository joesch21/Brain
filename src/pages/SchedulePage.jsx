import React, { useEffect, useMemo, useState } from "react";
import "../styles/schedule.css";
import SystemHealthBar from "../components/SystemHealthBar";
import ApiTestButton from "../components/ApiTestButton";
import { fetchApiStatus, formatApiError } from "../utils/apiStatus";

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeFlights(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.flights)) return data.flights;
  return [];
}

const SchedulePage = () => {
  const [date, setDate] = useState(todayISO());
  const [operator, setOperator] = useState("");
  const [flights, setFlights] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadFlights(signal) {
    setLoading(true);
    setError("");

    const qs = new URLSearchParams();
    if (date) qs.set("date", date);
    if (operator) qs.set("operator", operator);

    const resp = await fetchApiStatus(`/api/flights?${qs.toString()}`, {
      signal,
    });

    if (signal?.aborted) return;

    if (!resp.ok) {
      setError(formatApiError("Flights", resp));
      setFlights([]);
    } else {
      setFlights(normalizeFlights(resp.data));
    }

    if (!signal?.aborted) {
      setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    loadFlights(controller.signal);
    return () => controller.abort();
  }, [date, operator]);

  const operatorOptions = useMemo(() => {
    const values = new Set();
    for (const flight of flights) {
      const op =
        flight.operator ||
        flight.carrier ||
        flight.airline ||
        flight.flight_operator ||
        flight.flightOperator;
      if (op) values.add(op);
    }
    return Array.from(values).sort();
  }, [flights]);

  const visibleFlights = useMemo(() => {
    if (!operator) return flights;
    return flights.filter((f) => {
      const op =
        f.operator || f.carrier || f.airline || f.flight_operator || f.flightOperator;
      return op === operator;
    });
  }, [flights, operator]);

  return (
    <div className="schedule-page">
      <header className="schedule-header">
        <div className="schedule-header-left">
          <h2>Daily Flight Schedule</h2>
          <label>
            Date:{" "}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        </div>
        <div className="schedule-header-right">
          <label>
            Operator:{" "}
            <select
              value={operator}
              onChange={(e) => setOperator(e.target.value)}
            >
              <option value="">All operators</option>
              {operatorOptions.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {/* System status + diagnostics row (CWO-13B) */}
      <div className="schedule-system-row">
        <SystemHealthBar date={date} />
        <ApiTestButton date={date} onAfterSeed={loadFlights} />
      </div>

      {loading && <div className="schedule-status">Loading schedule…</div>}
      {error && <div className="schedule-status schedule-status--error">{error}</div>}

      {!loading && !error && visibleFlights.length === 0 && (
        <div className="schedule-status schedule-status--warn">
          No flights returned for this date. If this seems wrong, check the office export or backend adapter.
        </div>
      )}

      <div className="schedule-table-wrapper">
        <table className="schedule-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Flight</th>
              <th>Dest</th>
              <th>Operator</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {visibleFlights.map((flight, idx) => {
              const flightNumber = flight.flight_number || flight.flightNumber || flight.flight_no;
              const time = flight.time_local || flight.timeLocal || flight.time || "";
              const dest = flight.destination || flight.dest || "";
              const op =
                flight.operator ||
                flight.carrier ||
                flight.airline ||
                flight.flight_operator ||
                flight.flightOperator ||
                "";
              const notes = flight.notes || "";

              return (
                <tr key={`${flightNumber || idx}-${time}`}> 
                  <td>{time}</td>
                  <td>{flightNumber || "—"}</td>
                  <td>{dest || "—"}</td>
                  <td>{op || "—"}</td>
                  <td>{notes || ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

export default SchedulePage;
