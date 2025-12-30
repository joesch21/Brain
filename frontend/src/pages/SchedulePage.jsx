import React, { useEffect, useMemo, useState } from "react";
import "../styles/schedule.css";
import { extractFlightsList, normalizeFlightRow } from "../lib/flightNormalize";
import {
  buildAssignmentsByFlightKey,
  buildPlaceholderAssignments,
  getPlaceholderRoster,
} from "../lib/staffMvp";

import SystemHealthBar from "../components/SystemHealthBar";
import ApiTestButton from "../components/ApiTestButton";

import { fetchFlights, fetchStatus, pullFlights } from "../lib/apiClient";
import { REQUIRED_AIRPORT, normalizeOperator } from "../lib/opsDefaults";
import { autoAssignStaff, fetchEmployeeAssignmentsForDate } from "../api/opsClient";

const DEFAULT_AIRPORT = REQUIRED_AIRPORT;

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function formatRequestError(label, err) {
  if (!err) return label;
  const statusLabel = err.status ?? "network";
  const message = err.message || "Request failed";
  const endpoint = err.url || "unknown endpoint";
  return `${label} ${statusLabel} @ ${endpoint} – ${message}`;
}

function formatSafeRequestError(label, response) {
  if (!response) return `${label} request failed.`;
  const statusLabel = response.status ?? "network";
  const endpoint = response.raw?.url || "unknown endpoint";
  const message =
    response.error ||
    response.data?.error ||
    response.data?.message ||
    "Request failed";
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

  const assignedCount = Array.isArray(result.assigned) ? result.assigned.length : 0;
  const unassignedCount = Array.isArray(result.unassigned) ? result.unassigned.length : 0;
  return `Auto-assigned staff for ${result.date || "selected date"}. Assigned: ${assignedCount}, unassigned: ${unassignedCount}.`;
}

function toSortedNormalizedFlights(payload) {
  const rawList = extractFlightsList(payload);
  const normalized = rawList.map(normalizeFlightRow);

  // Sort by ISO time (estimated_off > scheduled_off inside normalizeFlightRow)
  normalized.sort((a, b) => {
    const ta = a.time_iso ? Date.parse(a.time_iso) : 0;
    const tb = b.time_iso ? Date.parse(b.time_iso) : 0;
    return ta - tb;
  });

  return normalized;
}

const SchedulePage = () => {
  const [date, setDate] = useState(todayISO());
  const [airline, setAirline] = useState("");
  const [flights, setFlights] = useState([]);
  const [flightsCount, setFlightsCount] = useState(null);
  const [flightsOk, setFlightsOk] = useState(null);
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
    setFlightsOk(null);

    try {
      const statusResp = await fetchStatus(date, { signal });
      if (!signal?.aborted) setStatusData(statusResp.data || null);
    } catch (err) {
      if (!signal?.aborted) {
        const message = formatRequestError("Status", err);
        setStatusError(message);
        setStatusData(null);
        setError((prev) => prev || message);
      }
    }

    try {
      const flightsResp = await fetchFlights(
        date,
        airline || "ALL",
        DEFAULT_AIRPORT,
        { signal }
      );

      if (!signal?.aborted) {
        const payload = flightsResp.data || {};
        const normalizedFlights = toSortedNormalizedFlights(payload);

        setFlights(normalizedFlights);
        // IMPORTANT: keep counters aligned with what we render
        setFlightsCount(normalizedFlights.length);
        setFlightsOk(true);
      }
    } catch (err) {
      if (!signal?.aborted) {
        setFlights([]);
        setFlightsCount(null);
        setFlightsOk(false);
        setError(formatRequestError("Flights", err));
      }
    }

    try {
      const assignmentsResp = await fetchEmployeeAssignmentsForDate(date, {
        airport: REQUIRED_AIRPORT,
        operator: normalizeOperator(airline || "ALL"),
        shift: "ALL",
      });
      if (!signal?.aborted) setAssignments(assignmentsResp);
    } catch {
      if (!signal?.aborted) {
        // Optional overlay: silently ignore.
        setAssignments([]);
        setAssignmentsError("");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date, airline]);

  useEffect(() => {
    setAutoAssignStatus(null);
  }, [date]);

  const airlineOptions = useMemo(() => {
    const values = new Set();
    for (const flight of flights) {
      if (flight.operator_code) values.add(flight.operator_code);
    }
    return Array.from(values).sort();
  }, [flights]);

  const visibleFlights = useMemo(() => {
    if (!airline) return flights;
    return flights.filter((f) => f.operator_code === airline);
  }, [flights, airline]);

  const placeholderRoster = useMemo(
    () => getPlaceholderRoster(date, DEFAULT_AIRPORT),
    [date]
  );
  const placeholderAssignments = useMemo(
    () => buildPlaceholderAssignments(flights, placeholderRoster),
    [flights, placeholderRoster]
  );
  const resolvedAssignments =
    assignments && assignments.length ? assignments : placeholderAssignments;
  const assignmentsByFlightKey = useMemo(
    () => buildAssignmentsByFlightKey(resolvedAssignments, flights),
    [resolvedAssignments, flights]
  );

  async function refreshFlightsOnly() {
    if (!date) throw new Error("Flights refresh requires a date.");
    const op = airline || "ALL";

    const flightsResp = await fetchFlights(date, op, DEFAULT_AIRPORT);
    const payload = flightsResp.data || {};
    const normalizedFlights = toSortedNormalizedFlights(payload);

    setFlights(normalizedFlights);
    setFlightsCount(normalizedFlights.length);
    setFlightsOk(true);

    return { count: normalizedFlights.length };
  }

  async function handleAutoAssignStaff() {
    if (!date) return;
    setAutoAssignLoading(true);
    setAutoAssignStatus(null);
    try {
      const result = await autoAssignStaff(date, airline || "ALL");
      if (result && result.ok === false) throw new Error(result.message || "Auto-assign staff failed.");
      setAutoAssignStatus({ ok: true, message: formatAutoAssignSummary(result.data) });
      await loadSchedule();
    } catch (err) {
      setAutoAssignStatus({ ok: false, message: err?.message || "Auto-assign staff failed." });
    } finally {
      setAutoAssignLoading(false);
    }
  }

  async function handlePullFlights() {
    if (!canPullFlights || pullLoading) return;
    setPullLoading(true);
    setPullStatus(null);
    const op = airline ? airline : "ALL";
    const resp = await pullFlights(date, op, {
      airport: DEFAULT_AIRPORT,
      timeoutMs: 60000,
    });
    const upstreamStatus = resp?.data?.status ?? resp?.status;

    if (!resp.ok) {
      setPullStatus({
        ok: false,
        message: `${formatSafeRequestError("Pull flights", resp)}${
          upstreamStatus != null ? ` (status ${upstreamStatus})` : ""
        }`,
      });
      setPullLoading(false);
      return;
    }

    try {
      const refreshed = await refreshFlightsOnly();
      const refreshedCount = refreshed?.count ?? 0;
      setPullStatus({
        ok: true,
        message: `Pulled ${refreshedCount} flight${refreshedCount === 1 ? "" : "s"} for ${date} (${op})${
          upstreamStatus != null ? ` – status ${upstreamStatus}` : ""
        }.`,
      });
    } catch (refreshErr) {
      setPullStatus({
        ok: false,
        message: `Pull completed for ${date} (${op})${
          upstreamStatus != null ? ` – status ${upstreamStatus}` : ""
        }. ${formatRequestError("Refresh flights", refreshErr)}`,
      });
    } finally {
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
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <div className="schedule-header-right">
          <label>
            Airline:{" "}
            <select value={airline} onChange={(e) => setAirline(e.target.value)}>
              <option value="">All airlines</option>
              {airlineOptions.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="schedule-actions">
        <button type="button" onClick={() => loadSchedule()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
        <button type="button" onClick={handleAutoAssignStaff} disabled={autoAssignLoading || loading}>
          {autoAssignLoading ? "Assigning staff…" : "Auto-assign staff"}
        </button>
        <ApiTestButton date={date} onAfterSeed={() => loadSchedule()} />
      </div>

      {autoAssignStatus && (
        <div
          className={
            "schedule-status " +
            (autoAssignStatus.ok ? "schedule-status--success" : "schedule-status--error")
          }
        >
          {autoAssignStatus.message}
        </div>
      )}

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
        <div className="schedule-status schedule-status--warn">{assignmentsError}</div>
      )}

      {!loading && !error && flightsOk && flightsCount === 0 && (
        <div className="schedule-status schedule-status--warn">
          <div style={{ display: "flex", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
            <span>
              No flights returned for this date. Use <b>Pull flights</b> to ingest/store them explicitly.
            </span>
            <button
              type="button"
              onClick={handlePullFlights}
              disabled={!canPullFlights || pullLoading || loading}
              title="Explicitly pull flights for this date (no automatic ingestion)."
            >
              {pullLoading ? "Pulling…" : "Pull flights"}
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
        <div className="schedule-status schedule-status--warn">No flights match the selected airline.</div>
      )}

      <div className="schedule-table-wrapper">
        <table className="schedule-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Flight</th>
              <th>Dest</th>
              <th>Airline</th>
              <th>Staff</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {visibleFlights.map((flight, idx) => {
              // Normalized shape (from normalizeFlightRow)
              const flightNumber = flight.flight_number || flight.ident;
              const time = flight.time_local || flight.time;
              const dest = flight.dest;
              const op = flight.operator_code;
              const notes = flight.raw?.notes || flight.notes || "";
              const rowKey =
                flight.flight_key ??
                flight.flight_id ??
                `${flight.flight_number || flight.ident || "UNK"}|${flight.time_iso || ""}`;

              const assignment = assignmentsByFlightKey.get(
                flight.flight_key || flight.key
              );
              const primaryAssignment = Array.isArray(assignment)
                ? assignment[0]
                : assignment;

              const staffInitials =
                primaryAssignment?.staff_initials ||
                initialsFromName(
                  primaryAssignment?.staff_name || primaryAssignment?.staff_code
                );
              const staffLabel = primaryAssignment?.staff_label;
              const staffDisplay = primaryAssignment
                ? `${staffInitials || primaryAssignment.staff_name || primaryAssignment.staff_code || ""}${
                    staffLabel ? ` (${staffLabel})` : ""
                  }`
                : null;

              return (
                <tr key={rowKey}>
                  <td>{time || "—"}</td>
                  <td>{flightNumber || "—"}</td>
                  <td>{dest || "—"}</td>
                  <td>{op || "—"}</td>
                  <td>
                    {assignmentsLoading ? (
                      <span className="schedule-staff schedule-staff--loading">Loading…</span>
                    ) : staffDisplay ? (
                      <span className="schedule-staff">{staffDisplay}</span>
                    ) : (
                      <span className="schedule-staff schedule-staff--unassigned">Unassigned</span>
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
