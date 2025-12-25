import React, { useEffect, useMemo, useState } from "react";
import "../styles/schedule.css";

import SystemHealthBar from "../components/SystemHealthBar";
import ApiTestButton from "../components/ApiTestButton";

import {
  fetchEmployeeAssignments,
  fetchFlights,
  fetchStatus,
  pullFlights,
} from "../lib/apiClient";
import { autoAssignStaff } from "../api/opsClient";

const DEFAULT_AIRPORT = "YSSY";

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
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.flights)) return data.flights;
  return [];
}

function formatRequestError(label, err) {
  if (!err) return label;
  const statusLabel = err.status ?? "network";
  const message = err.message || "Request failed";
  const endpoint = err.url || "unknown endpoint";
  return `${label} ${statusLabel} @ ${endpoint} – ${message}`;
}

function initialsFromName(name) {
  if (!name) return "";
  const parts = name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() || "");
  if (parts.length === 0) return name.slice(0, 2).toUpperCase();
  return parts.join("");
}

function formatAutoAssignSummary(result) {
  if (!result) return "Auto-assigned staff.";
  if (result.ok === false) {
    return result.message || "Auto-assign staff failed.";
  }

  const summary = result.summary;
  if (summary) {
    const base = `Assigned ${summary.assigned_flights} of ${summary.total_flights} flights.`;
    const staffCounts = `FT: ${summary.full_time_staff}, PT: ${summary.part_time_staff}`;
    const unassigned = summary.unassigned_flights ?? 0;
    const reason = summary.reason ? ` Reason: ${summary.reason}.` : "";
    return `${base} (${staffCounts}) Unassigned: ${unassigned}.${reason}`;
  }

  const assignedCount = Array.isArray(result.assigned)
    ? result.assigned.length
    : 0;
  const unassignedCount = Array.isArray(result.unassigned)
    ? result.unassigned.length
    : 0;
  return `Auto-assigned staff for ${result.date || "selected date"}. Assigned: ${assignedCount}, unassigned: ${unassignedCount}.`;
}

const SchedulePage = () => {
  const [date, setDate] = useState(todayISO());
  const [operator, setOperator] = useState("");
  const [flights, setFlights] = useState([]);
  const [flightsCount, setFlightsCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [assignments, setAssignments] = useState([]);
  const [assignmentsError, setAssignmentsError] = useState("");
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [autoAssignLoading, setAutoAssignLoading] = useState(false);
  const [autoAssignStatus, setAutoAssignStatus] = useState(null);
  const [statusData, setStatusData] = useState(null);
  const [statusError, setStatusError] = useState("");
  const [pullLoading, setPullLoading] = useState(false);
  const [pullStatus, setPullStatus] = useState(null);
  const canPullFlights = Boolean(date && DEFAULT_AIRPORT);

  async function loadSchedule(signal) {
    setLoading(true);
    setError("");
    setStatusError("");
    setAssignmentsError("");
    setAssignmentsLoading(true);
    setFlightsCount(null);

    try {
      const statusResp = await fetchStatus(date, { signal });
      if (!signal?.aborted) {
        setStatusData(statusResp.data || null);
      }
    } catch (err) {
      if (!signal?.aborted) {
        const message = formatRequestError("Status", err);
        setStatusError(message);
        setStatusData(null);
        setError((prev) => prev || message);
      }
    }

    try {
      const flightsResp = await fetchFlights(date, operator || "ALL", {
        signal,
        airport: DEFAULT_AIRPORT,
      });

      if (!signal?.aborted) {
        const payload = flightsResp.data || {};
        const normalizedFlights = normalizeFlights(payload);
        setFlights(normalizedFlights);
        setFlightsCount(
          Number.isFinite(payload.count) ? payload.count : normalizedFlights.length
        );
      }
    } catch (err) {
      if (!signal?.aborted) {
        setFlights([]);
        setFlightsCount(null);
        setError(formatRequestError("Flights", err));
      }
    }

    try {
      const assignmentsResp = await fetchEmployeeAssignments(date, { signal });
      if (!signal?.aborted) {
        const payload = assignmentsResp.data || {};
        const list = Array.isArray(payload.assignments)
          ? payload.assignments
          : Array.isArray(payload)
            ? payload
            : [];
        setAssignments(list);
      }
    } catch (err) {
      if (!signal?.aborted) {
        const message = formatRequestError("Assignments", err);
        setAssignments([]);
        setAssignmentsError(message);
        setError((prev) => prev || message);
      }
    }

    if (!signal?.aborted) {
      setLoading(false);
      setAssignmentsLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    loadSchedule(controller.signal);
    return () => controller.abort();
  }, [date, operator]);

  useEffect(() => {
    setAutoAssignStatus(null);
  }, [date]);

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

  const assignmentsByFlightId = useMemo(() => {
    const map = new Map();
    for (const a of assignments) {
      if (a) {
        const key =
          a.flight_id != null
            ? String(a.flight_id)
            : a.flight_number || a.flight_no;
        if (key != null) {
          map.set(String(key), a);
        }
      }
    }
    return map;
  }, [assignments]);

  async function handleAutoAssignStaff() {
    if (!date) return;
    setAutoAssignLoading(true);
    setAutoAssignStatus(null);
    try {
      const result = await autoAssignStaff(date, operator || "ALL");
      if (result && result.ok === false) {
        throw new Error(result.message || "Auto-assign staff failed.");
      }
      setAutoAssignStatus({
        ok: true,
        message: formatAutoAssignSummary(result.data),
      });
      await loadSchedule();
    } catch (err) {
      setAutoAssignStatus({
        ok: false,
        message: err?.message || "Auto-assign staff failed.",
      });
    } finally {
      setAutoAssignLoading(false);
    }
  }

  async function handlePullFlights() {
    if (!canPullFlights) return;
    setPullLoading(true);
    setPullStatus(null);
    let shouldRefresh = false;
    try {
      const op = operator ? operator : "ALL";
      const resp = await pullFlights(date, op, { airport: DEFAULT_AIRPORT });
      const upstreamStatus = resp?.data?.status ?? resp?.status;
      setPullStatus({
        ok: true,
        message: `Pulled flights for ${date} (${op})${
          upstreamStatus != null ? ` – status ${upstreamStatus}` : ""
        }.`,
      });
      shouldRefresh = true;
    } catch (err) {
      const upstreamStatus =
        err?.data?.status ?? err?.data?.upstream_status ?? err?.status;
      setPullStatus({
        ok: false,
        message: `${formatRequestError("Pull flights", err)}${
          upstreamStatus != null ? ` (status ${upstreamStatus})` : ""
        }`,
      });
      if (err?.data?.ok === false) {
        shouldRefresh = true;
      }
    } finally {
      if (shouldRefresh) {
        await loadSchedule();
      }
      setPullLoading(false);
    }
  }

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

      <div className="schedule-actions">
        <button
          type="button"
          onClick={() => loadSchedule()}
          disabled={loading}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button
          type="button"
          onClick={handleAutoAssignStaff}
          disabled={autoAssignLoading || loading}
        >
          {autoAssignLoading ? "Assigning staff…" : "Auto-assign staff"}
        </button>
        <ApiTestButton
          date={date}
          onAfterSeed={() => loadSchedule()}
        />
      </div>

      {autoAssignStatus && (
        <div
          className={
            "schedule-status " +
            (autoAssignStatus.ok
              ? "schedule-status--success"
              : "schedule-status--error")
          }
        >
          {autoAssignStatus.message}
        </div>
      )}

      {/* System status + diagnostics row (CWO-13B) */}
      <div className="schedule-system-row">
        <SystemHealthBar
          date={date}
          status={statusData}
          statusError={statusError}
          loading={loading && !statusData && !statusError}
        />
      </div>

      {loading && <div className="schedule-status">Loading schedule…</div>}
      {error && <div className="schedule-status schedule-status--error">{error}</div>}
      {assignmentsError && (
        <div className="schedule-status schedule-status--warn">
          {assignmentsError}
        </div>
      )}

      {!loading && !error && flightsCount === 0 && (
        <div className="schedule-status schedule-status--warn">
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <span>
              No flights returned for this date. Use <b>Pull flights</b> to ingest/store
              them explicitly.
            </span>
            <button
              type="button"
              onClick={handlePullFlights}
              disabled={!canPullFlights || pullLoading || loading}
              title="Explicitly pull flights for this date (no automatic ingestion)."
            >
              {pullLoading ? "Pulling flights…" : "Pull flights"}
            </button>
          </div>
          {pullStatus && (
            <div
              className={`schedule-status ${
                pullStatus.ok ? "schedule-status--success" : "schedule-status--error"
              }`}
              style={{ marginTop: "0.5rem" }}
            >
              {pullStatus.message}
            </div>
          )}
        </div>
      )}
      {!loading && !error && flightsCount !== 0 && visibleFlights.length === 0 && (
        <div className="schedule-status schedule-status--warn">
          No flights match the selected operator.
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
              <th>Staff</th>
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
              const assignmentKey = String(flight.id ?? flightNumber ?? idx);
              const assignment = assignmentsByFlightId.get(assignmentKey);
              const staffInitials =
                assignment?.staff_initials ||
                initialsFromName(assignment?.staff_name || assignment?.staff_code);
              const staffLabel = assignment?.staff_label;
              const staffDisplay = assignment
                ? `${staffInitials || assignment.staff_name || assignment.staff_code || ""}${
                    staffLabel ? ` (${staffLabel})` : ""
                  }`
                : null;

              return (
                <tr key={`${flightNumber || idx}-${time}`}>
                  <td>{time}</td>
                  <td>{flightNumber || "—"}</td>
                  <td>{dest || "—"}</td>
                  <td>{op || "—"}</td>
                  <td>
                    {assignmentsLoading ? (
                      <span className="schedule-staff schedule-staff--loading">
                        Loading…
                      </span>
                    ) : staffDisplay ? (
                      <span className="schedule-staff">{staffDisplay}</span>
                    ) : (
                      <span className="schedule-staff schedule-staff--unassigned">
                        Unassigned
                      </span>
                    )}
                  </td>
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
