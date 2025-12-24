import React, { useCallback, useEffect, useMemo, useState } from "react";
import "../styles/planner.css";
import SystemHealthBar from "../components/SystemHealthBar";
import ApiTestButton from "../components/ApiTestButton";
import {
  fetchDailyRoster,
  fetchEmployeeAssignments,
  fetchFlights,
  fetchDailyRuns,
  fetchStaffRuns,
} from "../lib/apiClient";
import { decorateRuns, MAX_FLIGHTS_PER_RUN, MIN_GAP_MINUTES_TIGHT } from "../utils/runConflictUtils";

const DEFAULT_AIRPORT = "YSSY";

// --- small helpers ---------------------------------------------------------

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const DEFAULT_AIRLINE = "JQ";
const AIRLINE_OPTIONS = ["JQ", "QF", "VA", "ZL"];

// Extract airline code from a flight number, e.g. "JQ719" -> "JQ".
function getAirlineCode(flightNumber) {
  if (!flightNumber || typeof flightNumber !== "string") return "UNK";
  let prefix = "";
  for (const ch of flightNumber) {
    if (/[A-Za-z]/.test(ch)) prefix += ch;
    else break;
  }
  return prefix || "UNK";
}

const parseTimeToMinutes = (hhmm) => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

// Match how you conceptually think about shifts
const getBandForMinutes = (mins) => {
  // wrap-around case
  const inRange = (x, start, end) => {
    if (start <= end) return x >= start && x <= end;
    // overnight (e.g. 23:00–05:00)
    return x >= start || x <= end;
  };

  const amStart = 5 * 60;
  const amEnd = 12 * 60;
  const pmStart = 12 * 60 + 1;
  const pmEnd = 23 * 60;
  const nightStart = 23 * 60;
  const nightEnd = 5 * 60;

  if (inRange(mins, amStart, amEnd)) return "AM";
  if (inRange(mins, pmStart, pmEnd)) return "PM";
  if (inRange(mins, nightStart, nightEnd)) return "NIGHT";
  return "OTHER";
};

function classifyTimeBand(timeStr) {
  const mins = parseTimeToMinutes(timeStr);
  if (mins == null) return "UNKNOWN";
  const band = getBandForMinutes(mins);
  if (band === "AM" || band === "PM") return band;
  return "OTHER";
}

// Figure out which grouping a run belongs to, based on shift.start_time.
function classifyRunGroup(run) {
  const shift = run.shift || {};
  const mins = parseTimeToMinutes(shift.start_time || shift.startTime);
  if (mins == null) return "OTHER";
  if (mins < 12 * 60) return "AM";
  if (mins < 17 * 60) return "MIDDAY";
  return "EVENING";
}

function formatLocalTimeLabel(value) {
  if (!value || typeof value !== "string") return "—";
  if (value.length >= 16) return value.slice(11, 16);
  if (value.length >= 5) return value.slice(0, 5);
  return value;
}

// --- summary computation ----------------------------------------------------

function computeSummary(flights, flightToRunMap) {
  const summary = {
    total: 0,
    am: { total: 0, byAirline: {} },
    pm: { total: 0, byAirline: {} },
    unassigned: 0,
  };

  if (!Array.isArray(flights)) return summary;

  for (const f of flights) {
    summary.total += 1;

    const airline = getAirlineCode(f.flight_number || f.flightNumber);
    const timeStr = f.time_local || f.timeLocal || f.time || null;
    const band = classifyTimeBand(timeStr);

    const key = `${f.flight_number || f.flightNumber || ""}|${
      f.time_local || f.timeLocal || ""
    }`;
    const isAssigned = Boolean(flightToRunMap[key]);

    if (!isAssigned) summary.unassigned += 1;

    if (band === "AM") {
      summary.am.total += 1;
      summary.am.byAirline[airline] =
        (summary.am.byAirline[airline] || 0) + 1;
    } else if (band === "PM") {
      summary.pm.total += 1;
      summary.pm.byAirline[airline] =
        (summary.pm.byAirline[airline] || 0) + 1;
    }
  }

  return summary;
}

function formatByAirline(byAirline) {
  const entries = Object.entries(byAirline || {});
  if (!entries.length) return "—";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => `${code} ${count}`)
    .join(", ");
}

function normalizeFlights(data) {
  if (!data) return [];
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.flights)) return data.flights;
  if (Array.isArray(data)) return data;
  return [];
}

function normalizeRuns(data) {
  if (!data) return [];
  if (Array.isArray(data.records)) return data.records;
  if (Array.isArray(data.runs)) return data.runs;
  if (Array.isArray(data)) return data;
  return [];
}

function normalizeUnassigned(data) {
  if (!data) return [];
  if (Array.isArray(data.unassigned)) return data.unassigned;
  if (Array.isArray(data.unassigned_flights)) return data.unassigned_flights;
  if (Array.isArray(data.unassignedFlights)) return data.unassignedFlights;
  if (Array.isArray(data)) return data;
  return [];
}

function formatRequestError(label, err) {
  if (!err) return label;
  const validationMessage =
    err?.data && err.data.type === "validation_error" && err.data.error;
  if (validationMessage) {
    return `${label} validation – ${validationMessage}`;
  }

  const statusLabel = err.status ?? "network";
  const message = (err.data && err.data.error) || err.message || "Request failed";
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

function normalizeRoster(data) {
  if (!data) return [];
  if (Array.isArray(data.shifts)) return data.shifts;
  if (Array.isArray(data?.roster?.shifts)) return data.roster.shifts;
  return [];
}

function normalizeStaffRuns(data) {
  if (!data) return { runs: [], unassigned: [] };
  const runs = Array.isArray(data.runs) ? data.runs : Array.isArray(data) ? data : [];
  const unassigned = Array.isArray(data.unassigned) ? data.unassigned : [];
  return { runs, unassigned };
}

const SECONDARY_TIMEOUT_MS = 8000;

function createTimeoutSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timeoutId = null;

  const handleAbort = () => controller.abort();

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener("abort", handleAbort);
    }
  }

  if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  }

  return {
    signal: controller.signal,
    clear: () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (parentSignal) {
        parentSignal.removeEventListener("abort", handleAbort);
      }
    },
  };
}

// --- subcomponents ----------------------------------------------------------

/**
 * Left column: list of all flights for the day + Unassigned panel.
 */
function FlightListColumn({
  flights,
  unassignedFlights,
  flightToRunMap,
  assignmentByFlightId,
  assignmentsLoading,
  selectedFlightKey,
  onSelectFlight,
  onUnassignedDragStart,
  onUnassignedDrop,
  // NEW:
  isDraggingRunFlight,
  isUnassignedHover,
  onUnassignedDragEnter,
  onUnassignedDragLeave,
  handleStaffClick,
}) {
  const safeUnassigned = Array.isArray(unassignedFlights)
    ? unassignedFlights
    : [];

  return (
    <section className="planner-column planner-column--left">
      <h3>Flights</h3>

      {/* Unassigned panel is also a drop target for flights dragged from runs */}
      <section
        className={
          "planner-subpanel planner-subpanel--unassigned" +
          (isDraggingRunFlight && isUnassignedHover
            ? " planner-subpanel--droptarget"
            : "")
        }
        onDragOver={(event) => {
          if (onUnassignedDrop && isDraggingRunFlight) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDragEnter={(event) => {
          if (onUnassignedDragEnter && isDraggingRunFlight) {
            onUnassignedDragEnter();
          }
        }}
        onDragLeave={(event) => {
          if (onUnassignedDragLeave && isDraggingRunFlight) {
            onUnassignedDragLeave();
          }
        }}
        onDrop={(event) => {
          if (onUnassignedDrop && isDraggingRunFlight) {
            event.preventDefault();
            onUnassignedDrop();
            if (onUnassignedDragLeave) onUnassignedDragLeave();
          }
        }}
      >
        <h4>
          Unassigned flights{" "}
          <span className="tag tag--unassigned">{safeUnassigned.length}</span>
        </h4>
        <div className="planner-list">
          <table className="planner-table planner-table--compact">
            <thead>
              <tr>
                <th>#</th>
                <th>Flight</th>
                <th>Dest</th>
                <th>ETD</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {safeUnassigned.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ fontStyle: "italic" }}>
                    All flights are assigned to runs for this date.
                  </td>
                </tr>
              ) : (
                safeUnassigned.map((f) => {
                  const flightNumber = f.flight_number || f.flightNumber;
                  const timeStr =
                    f.dep_time ||
                    f.time_local ||
                    f.timeLocal ||
                    f.planned_start_time ||
                    f.plannedStartTime ||
                    "";
                  const dest = f.destination || f.dest || "";
                  const reason = f.reason || f.unassigned_reason || "";
                  const seq =
                    f.sequence_index ??
                    f.sequenceIndex ??
                    f.sequence ??
                    null;
                  const key = `${flightNumber}|${timeStr}`;
                  const isSelected = selectedFlightKey === key;
                  const flightId = f.flight_id || f.id;

                  return (
                    <tr
                      key={key}
                      className={
                        "planner-row" +
                        (isSelected ? " planner-row--selected" : "")
                      }
                      onClick={() => onSelectFlight(key)}
                      draggable={Boolean(onUnassignedDragStart) && flightId != null}
                      onDragStart={(event) => {
                        if (onUnassignedDragStart && flightId != null) {
                          event.dataTransfer.effectAllowed = "move";
                          onUnassignedDragStart(flightId);
                        }
                      }}
                    >
                      <td>{seq != null ? seq + 1 : "—"}</td>
                      <td>{flightNumber}</td>
                      <td>{dest || "—"}</td>
                      <td>{timeStr || "—"}</td>
                      <td>
                        {reason ? (
                          <span className="planner-reason">{reason}</span>
                        ) : (
                          <span className="planner-subtext">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="planner-list">
        <table className="planner-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Flight</th>
              <th>Dest</th>
              <th>Airline</th>
              <th>Staff</th>
              <th>Assigned</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((f) => {
              const flightNumber = f.flight_number || f.flightNumber;
              const timeStr = f.time_local || f.timeLocal || "";
              const dest = f.destination || f.dest || "";
              const airline = getAirlineCode(flightNumber);
              const flightId = f.id || f.flight_id;
              const key = `${flightNumber}|${timeStr}`;
              const assignedRun = flightToRunMap[key];
              const assignedForFlight =
                assignmentByFlightId?.get(flightId) || [];
              const primaryAssignment = assignedForFlight[0];
              const isSelected = selectedFlightKey === key;

              return (
                <tr
                  key={key}
                  className={
                    "planner-row" +
                    (isSelected ? " planner-row--selected" : "")
                  }
                  onClick={() => onSelectFlight(key, assignedRun?.runId)}
                >
                  <td>{timeStr}</td>
                  <td>{flightNumber}</td>
                  <td>{dest}</td>
                  <td>{airline}</td>
                  <td>
                    {assignmentsLoading ? (
                      <span className="planner-subtext">Loading…</span>
                    ) : primaryAssignment ? (
                      <button
                        type="button"
                        className="link-button staff-link"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleStaffClick(
                            primaryAssignment.staff_code,
                            primaryAssignment.staff_name
                          );
                        }}
                      >
                        {primaryAssignment.staff_code} – {primaryAssignment.staff_name}
                      </button>
                    ) : (
                      <span className="flight-unassigned">Unassigned</span>
                    )}
                  </td>
                  <td>
                    {assignedRun ? (
                      <span className="tag tag--assigned">
                        {assignedRun.operator} • {assignedRun.runLabel}
                      </span>
                    ) : (
                      <span className="tag tag--unassigned">Unassigned</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * Center column: run cards grouped by shift band.
 */
function RunsGridColumn({
  runs,
  selectedRunId,
  onSelectRun,
  onRunsReorder,
  onRunDropFromOutside,
  onRunFlightDragStart,
  // NEW:
  isDraggingUnassignedFlight,
  hoverRunId,
  onRunCardDragEnter,
  onRunCardDragLeave,
}) {
  const grouped = useMemo(() => {
    const groups = { AM: [], MIDDAY: [], EVENING: [], OTHER: [] };
    for (const run of runs) {
      const g = classifyRunGroup(run);
      groups[g] = groups[g] || [];
      groups[g].push(run);
    }
    return groups;
  }, [runs]);

  const groupOrder = [
    ["AM", "AM (05:00–12:00)"],
    ["MIDDAY", "Midday (12:00–17:00)"],
    ["EVENING", "Evening (17:00–23:00)"],
    ["OTHER", "Other"],
  ];

  const [dragging, setDragging] = useState(null); // { runId, index }

  const handleDragStart = (runId, index) => (event) => {
    setDragging({ runId, index });
    event.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (targetRunId, targetIndex) => (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  };

  const moveFlightBetweenRuns = (
    currentRuns,
    sourceRunId,
    sourceIndex,
    targetRunId,
    targetIndex
  ) => {
    const cloned = currentRuns.map((run) => {
      const flightsArr =
        run.flights || run.flight_runs || run.flightRuns || [];
      const copy = flightsArr.slice();
      if (run.flights) return { ...run, flights: copy };
      if (run.flight_runs) return { ...run, flight_runs: copy };
      if (run.flightRuns) return { ...run, flightRuns: copy };
      return run;
    });

    const sourceRun = cloned.find((r) => r.id === sourceRunId);
    const targetRun = cloned.find((r) => r.id === targetRunId);
    if (!sourceRun || !targetRun) return currentRuns;

    const getArr = (run) => run.flights || run.flight_runs || run.flightRuns || [];
    const sourceArr = getArr(sourceRun);
    const targetArr = getArr(targetRun);

    if (sourceIndex < 0 || sourceIndex >= sourceArr.length) return currentRuns;

    const [moved] = sourceArr.splice(sourceIndex, 1);
    const insertIndex =
      targetRunId === sourceRunId && targetIndex > sourceIndex
        ? targetIndex - 1
        : targetIndex;
    targetArr.splice(insertIndex, 0, moved);

    return cloned;
  };

  const handleDrop = (targetRunId, targetIndex) => (event) => {
    event.preventDefault();
    if (!dragging) return;

    const { runId: sourceRunId, index: sourceIndex } = dragging;
    if (sourceRunId == null || sourceIndex == null) return;

    const updatedRuns = moveFlightBetweenRuns(
      runs,
      sourceRunId,
      sourceIndex,
      targetRunId,
      targetIndex
    );

    setDragging(null);
    if (onRunsReorder) onRunsReorder(updatedRuns);
  };

  return (
    <section className="planner-column planner-column--center">
      <h3>Runs</h3>
      <div className="planner-runs-grid">
        {groupOrder.map(([key, label]) => {
          const list = grouped[key] || [];
          if (!list.length) return null;
          return (
            <div key={key} className="planner-run-group">
              <h4>{label}</h4>
              <div className="planner-run-group-grid">
                {list.map((run) => {
                  const shift = run.shift || {};
                  const runLabel = run.label || run.run_label || "";
                  const op = run.operator_code || shift.operator_code || "";
                  const truck = run.truck_label || run.truck_id || "";
                  const refueller =
                    run.refueller ||
                    run.refueller_name ||
                    run.refueler ||
                    run.driver ||
                    "";
                  const startTime =
                    run.start_time ||
                    run.startTime ||
                    shift.start_time ||
                    shift.startTime ||
                    "—";
                  const endTime =
                    run.end_time ||
                    run.endTime ||
                    shift.end_time ||
                    shift.endTime ||
                    "—";
                  const flights =
                    run.flights || run.flight_runs || run.flightRuns || [];
                  const conflict = run.conflict || {};
                  const overloaded = conflict.overloaded;
                  const tightCount = conflict.tightConnections?.length || 0;
                  const hasConflicts = conflict.hasConflicts;
                  const runClassName =
                    "planner-run-card" +
                    (selectedRunId === run.id
                      ? " planner-run-card--selected"
                      : "") +
                    (isDraggingUnassignedFlight && hoverRunId === run.id
                      ? " planner-run-card--droptarget"
                      : "") +
                    (hasConflicts ? " planner-run-card--has-conflict" : "") +
                    (overloaded ? " planner-run-card--overloaded" : "");

                  return (
                    <div
                      key={run.id}
                      className={runClassName}
                      onClick={() => onSelectRun(run.id)}
                      onDragOver={(event) => {
                        // Allow drops from Unassigned onto the whole run card.
                        if (onRunDropFromOutside && isDraggingUnassignedFlight) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          if (onRunCardDragEnter) onRunCardDragEnter(run.id);
                        }
                      }}
                      onDragLeave={(event) => {
                        if (onRunCardDragLeave && isDraggingUnassignedFlight) {
                          onRunCardDragLeave();
                        }
                      }}
                      onDrop={(event) => {
                        if (onRunDropFromOutside && isDraggingUnassignedFlight) {
                          event.preventDefault();
                          onRunDropFromOutside(run.id);
                          if (onRunCardDragLeave) onRunCardDragLeave();
                        }
                      }}
                    >
                      <div className="planner-run-card-header">
                        <div className="planner-run-card-title">
                          <div className="planner-run-title">
                            {runLabel || `Run ${run.id}`}
                          </div>
                          <div className="planner-run-card-sub">
                            {startTime} – {endTime}
                            {truck ? ` • Truck ${truck}` : null}
                            {refueller ? ` • Refueller: ${refueller}` : null}
                          </div>
                        </div>
                        <div className="planner-run-card-meta">
                          {op || "RUN"}
                        </div>
                      </div>
                      <div className="planner-run-card-inline">
                        <span className="planner-run-card-stat">
                          {flights.length} flights
                        </span>
                        {overloaded && (
                          <span className="planner-run-chip planner-run-chip--overloaded">
                            Overloaded
                          </span>
                        )}
                        {tightCount > 0 && (
                          <span className="planner-run-chip planner-run-chip--tight">
                            {tightCount} tight
                          </span>
                        )}
                      </div>
                      <table className="planner-table planner-table--compact">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>Flight</th>
                            <th>Dest</th>
                            <th>ETD</th>
                          </tr>
                        </thead>
                        <tbody>
                          {flights.map((fr, index) => {
                            const flt = fr.flight || fr;
                            const fn =
                              flt.flight_number || flt.flightNumber || "";
                            const time =
                              fr.dep_time ||
                              flt.dep_time ||
                              flt.time_local ||
                              flt.timeLocal ||
                              "";
                            const plannedStart =
                              fr.planned_start_time || fr.plannedStartTime || "";
                            const plannedEnd =
                              fr.planned_end_time || fr.plannedEndTime || "";
                            const dest =
                              fr.destination || flt.destination || flt.dest || "";
                            const sequence =
                              fr.sequence_index ??
                              fr.sequenceIndex ??
                              fr.sequence ??
                              index;
                            const key = fr.id || `${fn}|${time}`;
                            const isTight = fr.isTightConnection || flt.isTightConnection;
                            return (
                              <tr
                                key={key}
                                className={
                                  "planner-run-row" +
                                  (isTight ? " planner-run-row--tight" : "")
                                }
                                draggable
                                onDragStart={(event) => {
                                  // Existing run→run reordering
                                  handleDragStart(run.id, index)(event);
                                  // Global drag state for run→Unassigned drops
                                  if (
                                    onRunFlightDragStart &&
                                    flt.id != null &&
                                    fr.id != null
                                  ) {
                                    onRunFlightDragStart(run.id, fr.id, flt.id);
                                  }
                                }}
                                onDragOver={handleDragOver(run.id, index)}
                                onDrop={handleDrop(run.id, index)}
                              >
                                <td>{sequence + 1}</td>
                                <td>{fn}</td>
                                <td>{dest}</td>
                                <td>
                                  {time}
                                  {(plannedStart || plannedEnd) && (
                                    <div className="planner-subtext">
                                      {plannedStart || "?"} – {plannedEnd || "?"}
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          {flights.length === 0 && (
                            <tr>
                              <td colSpan={4} style={{ fontStyle: "italic" }}>
                                No flights assigned
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Right column: run sheet view for the selected run.
 */
function RunSheetColumn({ runs, selectedRunId, onUpdateFlightRun }) {
  const selectedRun =
    runs.find((r) => r.id === selectedRunId) || runs[0] || null;

  if (!selectedRun) {
    return (
      <section className="planner-column planner-column--right">
        <h3>Run sheet</h3>
        <p>Select a run card to view its run sheet.</p>
      </section>
    );
  }

  const shift = selectedRun.shift || {};
  const flights =
    selectedRun.flights ||
    selectedRun.flight_runs ||
    selectedRun.flightRuns ||
    [];

  const op = selectedRun.operator_code || shift.operator_code || "";
  const truck = selectedRun.truck_label || selectedRun.truck_id || "";
  const runLabel = selectedRun.label || selectedRun.run_label || "";
  const refueller =
    selectedRun.refueller ||
    selectedRun.refueller_name ||
    selectedRun.refueler ||
    selectedRun.driver ||
    "";
  const runStart =
    selectedRun.start_time ||
    selectedRun.startTime ||
    shift.start_time ||
    shift.startTime ||
    "—";
  const runEnd =
    selectedRun.end_time ||
    selectedRun.endTime ||
    shift.end_time ||
    shift.endTime ||
    "—";

  const handleFieldBlur = (fr, fieldName, value) => {
    const patch = { [fieldName]: value };
    onUpdateFlightRun(fr.id, patch);
  };

  const handleStatusChange = (fr, event) => {
    const value = event.target.value;
    onUpdateFlightRun(fr.id, { status: value });
  };

  const handleCheckboxChange = (fr, event) => {
    const checked = event.target.checked;
    onUpdateFlightRun(fr.id, { on_time: checked });
  };

  return (
    <section className="planner-column planner-column--right">
      <h3>Run sheet</h3>
      <div className="run-sheet-header">
        <div>
          <strong>Run:</strong> {runLabel}
        </div>
        <div>
          <strong>Window:</strong> {runStart}–{runEnd}
        </div>
        <div>
          <strong>Operator:</strong> {op || "—"}
        </div>
        <div>
          <strong>Vehicle No.:</strong> {truck || "—"}
        </div>
        <div>
          <strong>Refueller:</strong> {refueller || "—"}
        </div>
      </div>
      <div className="planner-list">
        <table className="planner-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Flight</th>
              <th>Dest</th>
              <th>Time</th>
              <th>Bay</th>
              <th>Rego</th>
              <th>On time</th>
              <th>Status</th>
              <th>Start fig</th>
              <th>Uplift</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((fr, index) => {
              const flt = fr.flight || fr;
              const fn = flt.flight_number || flt.flightNumber || "";
              const dest = flt.destination || flt.dest || "";
              const time =
                fr.dep_time ||
                flt.dep_time ||
                flt.time_local ||
                flt.timeLocal ||
                "";
              const plannedStart =
                fr.planned_start_time || fr.plannedStartTime || "";
              const plannedEnd =
                fr.planned_end_time || fr.plannedEndTime || "";
              const sequence =
                fr.sequence_index ?? fr.sequenceIndex ?? fr.sequence ?? index;
              const key = fr.id || `${fn}|${time}`;

              return (
                <tr key={key}>
                  <td>{sequence + 1}</td>
                  <td>{fn}</td>
                  <td>{dest}</td>
                  <td>
                    {time}
                    {(plannedStart || plannedEnd) && (
                      <div className="planner-subtext">
                        {plannedStart || "?"} – {plannedEnd || "?"}
                      </div>
                    )}
                  </td>
                  <td>
                    <input
                      type="text"
                      defaultValue={fr.bay || ""}
                      onBlur={(event) =>
                        handleFieldBlur(fr, "bay", event.target.value.trim())
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="text"
                      defaultValue={fr.rego || ""}
                      onBlur={(event) =>
                        handleFieldBlur(fr, "rego", event.target.value.trim())
                      }
                    />
                  </td>
                  <td style={{ textAlign: "center" }}>
                    <input
                      type="checkbox"
                      defaultChecked={Boolean(fr.on_time)}
                      onChange={(event) => handleCheckboxChange(fr, event)}
                    />
                  </td>
                  <td>
                    <select
                      value={fr.status || "planned"}
                      onChange={(event) => handleStatusChange(fr, event)}
                    >
                      <option value="planned">Planned</option>
                      <option value="in_progress">In progress</option>
                      <option value="done">Done</option>
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      defaultValue={
                        fr.start_figure !== null && fr.start_figure !== undefined
                          ? fr.start_figure
                          : ""
                      }
                      onBlur={(event) =>
                        handleFieldBlur(
                          fr,
                          "start_figure",
                          event.target.value.trim()
                        )
                      }
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      defaultValue={
                        fr.uplift !== null && fr.uplift !== undefined
                          ? fr.uplift
                          : ""
                      }
                      onBlur={(event) =>
                        handleFieldBlur(
                          fr,
                          "uplift",
                          event.target.value.trim()
                        )
                      }
                    />
                  </td>
                </tr>
              );
            })}
            {flights.length === 0 && (
              <tr>
                <td colSpan={10} style={{ fontStyle: "italic" }}>
                  No flights assigned to this run.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- main page --------------------------------------------------------------

const PlannerPage = () => {
  const [date, setDate] = useState(todayISO());
  const [airline, setAirline] = useState(DEFAULT_AIRLINE);
  const [flights, setFlights] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [runs, setRuns] = useState([]);
  const [unassigned, setUnassigned] = useState([]);
  const [staffRuns, setStaffRuns] = useState({ runs: [], unassigned: [] });
  const [roster, setRoster] = useState([]);
  const [runsDailyCount, setRunsDailyCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [assignmentsLoading, setAssignmentsLoading] = useState(false);
  const [loadingStaffRuns, setLoadingStaffRuns] = useState(false);
  const [generatingStaffRuns, setGeneratingStaffRuns] = useState(false);
  const [autoAssignLoading, setAutoAssignLoading] = useState(false);
  const [autoAssignError, setAutoAssignError] = useState("");
  const [autoAssignSuccess, setAutoAssignSuccess] = useState(false);
  const [error, setError] = useState("");
  const [runsError, setRunsError] = useState("");
  const [assignmentsError, setAssignmentsError] = useState("");
  const [staffViewError, setStaffViewError] = useState("");
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [selectedStaffId, setSelectedStaffId] = useState(null);
  const [activeTab, setActiveTab] = useState("runs");
  const [selectedFlightKey, setSelectedFlightKey] = useState(null);
  const [dragPayload, setDragPayload] = useState(null); // for cross-column DnD
  // Which run card (if any) is currently hovered as a drop target
  const [hoverRunId, setHoverRunId] = useState(null);
  // Whether the Unassigned panel is currently hovered as a drop target
  const [hoverUnassigned, setHoverUnassigned] = useState(false);
  const [selectedStaffKey, setSelectedStaffKey] = useState(null);
  const [isStaffPanelOpen, setIsStaffPanelOpen] = useState(false);

  const decorateRunsList = useCallback((list) => decorateRuns(list), []);

  const setRunsWithConflicts = useCallback(
    (value) => {
      if (typeof value === "function") {
        setRuns((prev) => decorateRunsList(value(prev)));
        return;
      }
      setRuns(decorateRunsList(value));
    },
    [decorateRunsList]
  );

  // Convenience flags based on dragPayload type
  const isDraggingUnassignedFlight = dragPayload?.type === "UNASSIGNED_FLIGHT";
  const isDraggingRunFlight = dragPayload?.type === "RUN_FLIGHT";

  const flightToRunMap = useMemo(() => {
    const map = {};
    for (const run of runs) {
      const shift = run.shift || {};
      const op = run.operator_code || shift.operator_code || "";
      const runLabel = run.label || run.run_label || "";
      const flightsArr =
        run.flights || run.flight_runs || run.flightRuns || [];
      for (const fr of flightsArr) {
        const flt = fr.flight || fr;
        const fn = flt.flight_number || flt.flightNumber || "";
        const timeStr = flt.time_local || flt.timeLocal || "";
        const key = `${fn}|${timeStr}`;
        map[key] = { runId: run.id, operator: op, runLabel };
      }
    }
    return map;
  }, [runs]);

  const summary = useMemo(
    () => computeSummary(flights, flightToRunMap),
    [flights, flightToRunMap]
  );

  // Flights that are NOT present in any run -> Unassigned pool
  const fallbackUnassignedFlights = useMemo(() => {
    if (!Array.isArray(flights) || !flights.length) return [];

    const assignedIds = new Set();
    for (const run of runs) {
      const flightsArr =
        run.flights || run.flight_runs || run.flightRuns || [];
      for (const fr of flightsArr) {
        const flt = fr.flight || fr;
        if (flt && flt.id != null) {
          assignedIds.add(flt.id);
        }
      }
    }

    return flights.filter(
      (f) => f && f.id != null && !assignedIds.has(f.id)
    );
  }, [flights, runs]);

  const displayedUnassignedFlights = useMemo(() => {
    if (Array.isArray(unassigned) && unassigned.length) return unassigned;
    return fallbackUnassignedFlights;
  }, [fallbackUnassignedFlights, unassigned]);

  const unassignedCount = useMemo(() => {
    if (Array.isArray(unassigned) && unassigned.length) return unassigned.length;
    return fallbackUnassignedFlights.length;
  }, [fallbackUnassignedFlights, unassigned]);

  const assignmentByFlightId = useMemo(() => {
    const map = new Map();
    (assignments || []).forEach((assignment) => {
      const fid = assignment.flight_id || assignment.flightId;
      if (fid == null) return;
      if (!map.has(fid)) {
        map.set(fid, []);
      }
      map.get(fid).push(assignment);
    });
    return map;
  }, [assignments]);

  const assignmentsByStaff = useMemo(() => {
    const map = new Map();
    (assignments || []).forEach((a) => {
      const key = `${a.staff_code}::${a.staff_name}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    });

    for (const list of map.values()) {
      list.sort((a, b) => (a.dep_time || "").localeCompare(b.dep_time || ""));
    }

    return map;
  }, [assignments]);

  const selectedStaffAssignments = useMemo(() => {
    if (!selectedStaffKey) return [];
    return assignmentsByStaff.get(selectedStaffKey) || [];
  }, [selectedStaffKey, assignmentsByStaff]);

  const SERVICE_SETUP_MIN = 30; // minutes before dep
  const SERVICE_TURNAROUND_MIN = 60; // minutes after dep

  const selectedStaffAnalysis = useMemo(() => {
    const list = selectedStaffAssignments;
    if (!list || list.length === 0) {
      return {
        total: 0,
        bandCounts: { AM: 0, PM: 0, NIGHT: 0, OTHER: 0 },
        conflictFlightIds: new Set(),
      };
    }

    const bandCounts = { AM: 0, PM: 0, NIGHT: 0, OTHER: 0 };

    const windows = list.map((a) => {
      const depMins = parseTimeToMinutes(a.dep_time);
      const band = depMins != null ? getBandForMinutes(depMins) : "OTHER";

      if (bandCounts[band] == null) bandCounts[band] = 0;
      bandCounts[band] += 1;

      const start = depMins != null ? depMins - SERVICE_SETUP_MIN : null;
      const end = depMins != null ? depMins + SERVICE_TURNAROUND_MIN : null;

      return {
        flight_id: a.flight_id,
        depMins,
        start,
        end,
      };
    });

    const conflictFlightIds = new Set();

    for (let i = 0; i < windows.length; i++) {
      const wi = windows[i];
      if (wi.start == null || wi.end == null) continue;

      for (let j = i + 1; j < windows.length; j++) {
        const wj = windows[j];
        if (wj.start == null || wj.end == null) continue;

        const overlap = wi.start < wj.end && wj.start < wi.end;

        if (overlap) {
          conflictFlightIds.add(wi.flight_id);
          conflictFlightIds.add(wj.flight_id);
        }
      }
    }

    return {
      total: list.length,
      bandCounts,
      conflictFlightIds,
    };
  }, [selectedStaffAssignments]);

  const staffRunsByStaffId = useMemo(() => {
    const map = new Map();
    (staffRuns.runs || []).forEach((run) => {
      const staffId = run.staff_id || run.staffId || run.staff?.id;
      if (staffId == null) return;
      const existing = map.get(staffId) || [];
      existing.push(run);
      map.set(staffId, existing);
    });
    return map;
  }, [staffRuns]);

  const selectedStaff = useMemo(
    () => roster.find((s) => (s.staff_id || s.staffId) === selectedStaffId),
    [roster, selectedStaffId]
  );

  const selectedStaffRuns = useMemo(
    () => staffRunsByStaffId.get(selectedStaffId) || [],
    [selectedStaffId, staffRunsByStaffId]
  );

  async function loadAssignmentsForDate(dateStr, signal) {
    if (!dateStr) return;

    setAssignmentsLoading(true);
    setAssignmentsError("");

    const { signal: timeoutSignal, clear } = createTimeoutSignal(
      signal,
      SECONDARY_TIMEOUT_MS
    );

    try {
      const resp = await fetchEmployeeAssignments(dateStr, {
        signal: timeoutSignal,
        airport: DEFAULT_AIRPORT,
      });
      const payload = resp.data || {};
      if (!signal?.aborted && !timeoutSignal.aborted) {
        const list = Array.isArray(payload.assignments)
          ? payload.assignments
          : Array.isArray(payload)
            ? payload
            : [];
        setAssignments(list);
      }
    } catch (err) {
      if (!signal?.aborted) {
        setAssignments([]);
        setAssignmentsError(
          err?.name === "AbortError"
            ? "Employee assignments timed out."
            : err?.message || "Failed to load employee assignments."
        );
      }
    } finally {
      clear();
      if (!signal?.aborted) {
        setAssignmentsLoading(false);
      }
    }
  }

  async function loadRosterForDate(dateStr, signal) {
    if (!dateStr) return;

    const { signal: timeoutSignal, clear } = createTimeoutSignal(
      signal,
      SECONDARY_TIMEOUT_MS
    );

    try {
      const rosterResp = await fetchDailyRoster(dateStr, { signal: timeoutSignal });
      if (!signal?.aborted && !timeoutSignal.aborted) {
        setRoster(normalizeRoster(rosterResp.data));
      }
    } catch (err) {
      if (!signal?.aborted) {
        setRoster([]);
        setStaffViewError(
          err?.name === "AbortError"
            ? "Roster timed out."
            : formatRequestError("Roster", err)
        );
      }
    } finally {
      clear();
    }
  }

  async function loadStaffRunsForDate(dateStr, airlineCode, signal) {
    if (!dateStr) return;

    const { signal: timeoutSignal, clear } = createTimeoutSignal(
      signal,
      SECONDARY_TIMEOUT_MS
    );

    try {
      const staffRunsResp = await fetchStaffRuns(dateStr, airlineCode, {
        signal: timeoutSignal,
      });
      if (!signal?.aborted && !timeoutSignal.aborted) {
        setStaffRuns(normalizeStaffRuns(staffRunsResp.data));
      }
    } catch (err) {
      if (!signal?.aborted) {
        setStaffRuns({ runs: [], unassigned: [] });
        setStaffViewError(
          err?.name === "AbortError"
            ? "Staff runs timed out."
            : formatRequestError("Staff runs", err)
        );
      }
    } finally {
      clear();
      if (!signal?.aborted) {
        setLoadingStaffRuns(false);
      }
    }
  }

  async function loadPlannerData(signal) {
    if (!date) return;

    const airlineCode = airline || DEFAULT_AIRLINE;

    setLoading(true);
    setLoadingRuns(true);
    setAssignmentsLoading(true);
    setLoadingStaffRuns(true);
    setError("");
    setRunsError("");
    setAssignmentsError("");
    setStaffViewError("");
    setRunsDailyCount(null);

    const flightsPromise = (async () => {
      try {
        const flightsResp = await fetchFlights(date, airlineCode, {
          signal,
          airport: DEFAULT_AIRPORT,
        });
        if (!signal?.aborted) {
          setFlights(normalizeFlights(flightsResp.data));
        }
      } catch (err) {
        if (!signal?.aborted) {
          setFlights([]);
          setError(formatRequestError("Flights", err));
        }
      }
    })();

    const runsPromise = (async () => {
      try {
        const runsResp = await fetchDailyRuns(
          date,
          { operator: (airlineCode || "ALL"), airport: DEFAULT_AIRPORT, shift: "ALL" },
          { signal }
        );

        if (signal?.aborted) {
          // no-op
        } else if (runsResp && runsResp.ok) {
          const payload = runsResp.data || {};
          const normalizedRuns = normalizeRuns(payload);
          setRunsWithConflicts(normalizedRuns);
          setUnassigned(normalizeUnassigned(payload));
          setRunsDailyCount(
            Number.isFinite(payload.count) ? payload.count : normalizedRuns.length
          );
          setRunsError("");
        } else {
          const statusLabel = runsResp?.status ?? "network";
          const endpoint = runsResp?.raw?.url || "/api/runs/daily";
          const message = runsResp?.error || "Request failed";
          setRunsWithConflicts([]);
          setUnassigned([]);
          setRunsDailyCount(null);
          setRunsError(`Runs ${statusLabel} @ ${endpoint} – ${message}`);
        }
      } catch (err) {
        if (!signal?.aborted) {
          setRunsWithConflicts([]);
          setUnassigned([]);
          setRunsDailyCount(null);
          setRunsError(formatRequestError("Runs", err));
        }
      }
    })();

    void loadAssignmentsForDate(date, signal);
    void loadRosterForDate(date, signal);
    void loadStaffRunsForDate(date, airlineCode, signal);

    await Promise.all([flightsPromise, runsPromise]);

    if (!signal?.aborted) {
      setLoading(false);
      setLoadingRuns(false);
    }
  }

  useEffect(() => {
    if (!date) return undefined;
    const controller = new AbortController();

    loadPlannerData(controller.signal);
    return () => controller.abort();
  }, [date, airline]);

  useEffect(() => {
    setAutoAssignError("");
    setAutoAssignSuccess(false);
  }, [date, airline]);

  useEffect(() => {
    if (!autoAssignSuccess) return undefined;
    const timer = setTimeout(() => setAutoAssignSuccess(false), 4000);
    return () => clearTimeout(timer);
  }, [autoAssignSuccess]);

  useEffect(() => {
    if (!roster.length) {
      setSelectedStaffId(null);
      return;
    }
    const stillExists = roster.some(
      (s) => (s.staff_id || s.staffId) === selectedStaffId
    );
    if (!stillExists) {
      const firstStaff = roster[0];
      setSelectedStaffId(firstStaff.staff_id || firstStaff.staffId);
    }
  }, [roster, selectedStaffId]);

  async function updateFlightRun(flightRunId, patch) {
    try {
      const resp = await fetch(`/api/flight_runs/${flightRunId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Update failed (${resp.status}): ${text || "Unknown error"}`
        );
      }
      const updated = await resp.json();

      setRunsWithConflicts((prevRuns) =>
        prevRuns.map((run) => {
          const flightsArr =
            run.flights || run.flight_runs || run.flightRuns || [];
          const newFlights = flightsArr.map((fr) =>
            fr.id === updated.id ? { ...fr, ...updated } : fr
          );

          if (run.flights) {
            return { ...run, flights: newFlights };
          }
          if (run.flight_runs) {
            return { ...run, flight_runs: newFlights };
          }
          if (run.flightRuns) {
            return { ...run, flightRuns: newFlights };
          }
          return run;
        })
      );
    } catch (err) {
      console.error(err);
      setError(err.message || "Error updating flight run.");
    }
  }

  async function persistLayout(newRuns) {
    const runsPayload = newRuns.map((run) => {
      const flightsArr =
        run.flights || run.flight_runs || run.flightRuns || [];
      const ids = flightsArr.map((fr) => fr.id);
      return { run_id: run.id, flight_run_ids: ids };
    });

    try {
      const resp = await fetch("/api/runs/update_layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runs: runsPayload }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Update layout failed (${resp.status}): ${text || "Unknown error"}`
        );
      }
    } catch (err) {
      console.error(err);
      setError(err.message || "Error updating layout.");
    }
  }

  function handleRunsReorder(newRuns) {
    setRunsWithConflicts(newRuns);
    persistLayout(newRuns);
  }

  async function handleAutoAssign() {
    if (!date) return;
    const airlineCode = airline || DEFAULT_AIRLINE;

    setAutoAssignLoading(true);
    setAutoAssignError("");
    setAutoAssignSuccess(false);
    try {
      const resp = await fetch("/api/runs/auto_assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date }),
      });
      let body = null;
      try {
        body = await resp.json();
      } catch (parseErr) {
        body = null;
      }

      if (!resp.ok || body?.ok !== true) {
        const message =
          (body && body.error) ||
          (body && body.message) ||
          `Auto-assign failed (${resp.status})`;
        throw new Error(message || "Auto-assign failed. Check backend logs.");
      }

      const newRuns = normalizeRuns(body || {});
      setRunsWithConflicts(newRuns);
      setUnassigned(normalizeUnassigned(body || {}));
      setRunsError("");
      setAutoAssignSuccess(true);
      setSelectedRunId((prev) => prev ?? (newRuns[0]?.id ?? null));

      try {
        const flightsResp = await fetchFlights(date, airlineCode, { airport: DEFAULT_AIRPORT });
        const flightsData = flightsResp.data || {};
        setFlights(normalizeFlights(flightsData));
        await loadAssignmentsForDate(date);
      } catch (flightErr) {
        console.error("Auto-assign refresh flights failed", flightErr);
      }
    } catch (err) {
      console.error(err);
      setAutoAssignError(
        err?.message || "Auto-assign failed. Check backend logs."
      );
    } finally {
      setAutoAssignLoading(false);
    }
  }

  async function handleGenerateStaffRuns() {
    if (!date) return;

    const airlineCode = airline || DEFAULT_AIRLINE;
    try {
      setStaffViewError("");
      setGeneratingStaffRuns(true);
      const resp = await fetch(
        `/api/staff_runs/generate?date=${encodeURIComponent(date)}&airline=${encodeURIComponent(airlineCode)}`,
        { method: "POST" }
      );
      const body = await resp.json();
      if (!resp.ok || body?.ok === false) {
        throw new Error(body?.error || "Failed to generate staff runs.");
      }

      await loadPlannerData();
    } catch (err) {
      console.error(err);
      setStaffViewError(err?.message || "Failed to generate staff runs.");
    } finally {
      setGeneratingStaffRuns(false);
    }
  }

  function handleSelectFlight(flightKey, runId) {
    setSelectedFlightKey(flightKey);
    if (runId) setSelectedRunId(runId);
  }

  function handleSelectRun(runId) {
    setSelectedRunId(runId);
  }

  function handleStaffClick(staffCode, staffName) {
    const key = `${staffCode}::${staffName}`;
    setSelectedStaffKey(key);
    setIsStaffPanelOpen(true);
  }

  // --- Drag & Drop: Unassigned <-> Runs ------------------------------------

  // Start dragging a flight from a run row.
  function handleRunFlightDragStart(runId, flightRunId, flightId) {
    setDragPayload({
      type: "RUN_FLIGHT",
      runId,
      flightRunId,
      flightId,
    });
  }

  // Start dragging a flight from the Unassigned panel.
  function handleUnassignedDragStart(flightId) {
    setDragPayload({
      type: "UNASSIGNED_FLIGHT",
      flightId,
    });
  }

  // Drop from Unassigned onto a run card: call /api/flight_runs/assign
  async function handleDropOnRunCard(targetRunId) {
    if (!dragPayload || dragPayload.type !== "UNASSIGNED_FLIGHT") return;
    const { flightId } = dragPayload;
    if (flightId == null) return;

    try {
      const resp = await fetch("/api/flight_runs/assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: targetRunId, flight_id: flightId }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Assign failed (${resp.status}): ${text || "Unknown error"}`
        );
      }
      const data = await resp.json();
      const newFR = data.flight_run || data;

      // Optimistically append to the target run's flights list
      setRunsWithConflicts((prevRuns) =>
        prevRuns.map((run) => {
          if (run.id !== targetRunId) return run;

          const flightsArr =
            run.flights || run.flight_runs || run.flightRuns || [];

          const updatedArr = [...flightsArr, newFR];

          if (run.flights) return { ...run, flights: updatedArr };
          if (run.flight_runs) return { ...run, flight_runs: updatedArr };
          if (run.flightRuns) return { ...run, flightRuns: updatedArr };
          return run;
        })
      );
    } catch (err) {
      console.error(err);
      setError(err.message || "Error assigning flight to run.");
    } finally {
      setDragPayload(null);
    }
  }

  // Drop a run-flight onto the Unassigned panel: call /api/flight_runs/unassign
  async function handleDropOnUnassigned() {
    if (!dragPayload || dragPayload.type !== "RUN_FLIGHT") return;
    const { flightRunId } = dragPayload;
    if (flightRunId == null) return;

    try {
      const resp = await fetch("/api/flight_runs/unassign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flight_run_id: flightRunId }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(
          `Unassign failed (${resp.status}): ${text || "Unknown error"}`
        );
      }

      // Remove this FlightRun from whichever run currently contains it.
      setRunsWithConflicts((prevRuns) =>
        prevRuns.map((run) => {
          const flightsArr =
            run.flights || run.flight_runs || run.flightRuns || [];
          const filtered = flightsArr.filter((fr) => fr.id !== flightRunId);

          if (run.flights) return { ...run, flights: filtered };
          if (run.flight_runs) return { ...run, flight_runs: filtered };
          if (run.flightRuns) return { ...run, flightRuns: filtered };
          return run;
        })
      );
    } catch (err) {
      console.error(err);
      setError(err.message || "Error unassigning flight.");
    } finally {
      setDragPayload(null);
    }
  }

  const renderStaffDayPanel = () => {
    if (!isStaffPanelOpen || !selectedStaffKey) return null;

    const [code = "", name = ""] = selectedStaffKey.split("::");
    const list = selectedStaffAssignments;
    const { total, bandCounts, conflictFlightIds } = selectedStaffAnalysis;
    const hasConflicts = conflictFlightIds.size > 0;

    return (
      <div
        className="staff-panel-overlay"
        onClick={() => setIsStaffPanelOpen(false)}
        role="presentation"
      >
        <aside
          className="staff-panel"
          onClick={(e) => e.stopPropagation()}
          aria-label="Staff day schedule"
        >
          <header className="staff-panel__header">
            <div>
              <div className="staff-panel__title">{name}</div>
              <div className="staff-panel__subtitle">
                {code} · Schedule for {date}
              </div>
              <div className="staff-panel__load">
                Load: {total} flight{total === 1 ? "" : "s"}
                {total > 0 && (
                  <>
                    {" · "}
                    AM {bandCounts.AM || 0}, PM {bandCounts.PM || 0}
                    {bandCounts.NIGHT ? `, Night ${bandCounts.NIGHT}` : ""}
                  </>
                )}
                {hasConflicts && (
                  <span className="staff-panel__load-warning">
                    {" "}· Conflicts detected
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="staff-panel__close"
              onClick={() => setIsStaffPanelOpen(false)}
              aria-label="Close staff schedule"
            >
              ×
            </button>
          </header>

          <section className="staff-panel__body">
            {list.length === 0 ? (
              <p>No assignments for this staff member on this date.</p>
            ) : (
              <ul className="staff-panel__list">
                {list.map((a) => {
                  const key =
                    a.flight_id ||
                    a.flightId ||
                    `${a.flight_number || a.flightNumber || ""}-${a.dep_time}`;
                  const isConflict = conflictFlightIds.has(a.flight_id);
                  return (
                    <li
                      key={key}
                      className={`staff-panel__item${
                        isConflict ? " staff-panel__item--conflict" : ""
                      }`}
                    >
                      <div className="staff-panel__time">{a.dep_time}</div>
                      <div className="staff-panel__flight">
                        <div className="staff-panel__flight-main">
                          {a.flight_number || a.flightNumber}
                          {a.dest && <> → {a.dest}</>}
                        </div>
                        {a.role && <div className="staff-panel__role">Role: {a.role}</div>}
                        {isConflict && (
                          <div className="staff-panel__conflict">
                            ⚠ Overlaps another assignment
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>
      </div>
    );
  };

  return (
    <div className="planner-page">
      <header className="planner-header">
        <div className="planner-header-left">
          <h2>Daily Ops Planner</h2>
          <label>
            Date:{" "}
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label style={{ marginLeft: "0.75rem" }}>
            Airline:{" "}
            <select
              value={airline}
              onChange={(e) => setAirline(e.target.value)}
            >
              {AIRLINE_OPTIONS.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="planner-header-right">
          <button
            type="button"
            onClick={handleGenerateStaffRuns}
            disabled={generatingStaffRuns || loadingStaffRuns}
          >
            {generatingStaffRuns ? "Generating staff runs…" : "Generate staff runs"}
          </button>
          <button
            type="button"
            onClick={handleAutoAssign}
            disabled={autoAssignLoading}
          >
            {autoAssignLoading ? "Auto-assigning…" : "Auto-assign runs"}
          </button>
        </div>
      </header>

      <div className="planner-autoassign-row">
        {autoAssignLoading && (
          <div className="planner-status">
            Auto-assigning… please wait
          </div>
        )}
        {autoAssignSuccess && !autoAssignLoading && (
          <div className="planner-status planner-status--success">
            Runs auto-assigned for {date}
          </div>
        )}
        {autoAssignError && (
          <div className="planner-status planner-status--error">
            {autoAssignError}
          </div>
        )}
      </div>

      {/* System status + diagnostics row */}
      <div className="planner-system-row">
        <SystemHealthBar date={date} />
        <ApiTestButton date={date} onAfterSeed={loadPlannerData} />
      </div>

      {(loading || loadingRuns) && (
        <div className="planner-status">Loading data…</div>
      )}
      {error && (
        <div className="planner-status planner-status--error">
          {error}
        </div>
      )}
      {!loading && !loadingRuns && !error && runsError && (
        <div className="planner-status planner-status--warn">
          {runsError || "Runs could not be loaded."}
        </div>
      )}
      {!loading && !assignmentsLoading && !error && assignmentsError && (
        <div className="planner-status planner-status--warn">
          {assignmentsError}
        </div>
      )}

      {/* CWO-12: page-specific missing-data indicators */}
      {!loading &&
        !loadingRuns &&
        !error &&
        flights.length === 0 && (
          <div className="planner-status planner-status--warn">
            No flights returned for this date from the backend.
            If this looks wrong, check the office system export or DB adapter.
          </div>
        )}

      {!loading &&
        !loadingRuns &&
        !error &&
        !runsError &&
        runsDailyCount === 0 && (
          <div className="planner-status planner-status--warn">
            No runs returned for this date from the backend.
            If this looks wrong, check the office runs configuration.
          </div>
        )}

      {!loading &&
        !assignmentsLoading &&
        !error &&
        !assignmentsError &&
        flights.length > 0 &&
        assignments.length === 0 && (
          <div className="planner-status planner-status--warn">
            No assignments found for this date — run “Prepare ops day” from
            Machine Room.
          </div>
        )}

      {!error && (
        <>
          <div className="planner-legend">
            <span className="legend-item">
              <span className="legend-swatch legend-swatch--overloaded" />
              Overloaded run (&gt; {MAX_FLIGHTS_PER_RUN} flights)
            </span>
            <span className="legend-item">
              <span className="legend-swatch legend-swatch--tight" />
              Tight connection (&lt; {MIN_GAP_MINUTES_TIGHT} mins between flights)
            </span>
          </div>
          <div className="planner-tabs">
            <button
              type="button"
              className={activeTab === "runs" ? "active" : ""}
              onClick={() => setActiveTab("runs")}
            >
              Runs View
            </button>
            <button
              type="button"
              className={activeTab === "staff" ? "active" : ""}
              onClick={() => setActiveTab("staff")}
            >
              Staff View
            </button>
          </div>

          {activeTab === "runs" ? (
            <main className="planner-main">
              <FlightListColumn
                flights={flights}
                unassignedFlights={displayedUnassignedFlights}
                flightToRunMap={flightToRunMap}
                assignmentByFlightId={assignmentByFlightId}
                assignmentsLoading={assignmentsLoading}
                selectedFlightKey={selectedFlightKey}
                onSelectFlight={handleSelectFlight}
                onUnassignedDragStart={handleUnassignedDragStart}
                onUnassignedDrop={handleDropOnUnassigned}
                isDraggingRunFlight={isDraggingRunFlight}
                isUnassignedHover={hoverUnassigned}
                onUnassignedDragEnter={() => setHoverUnassigned(true)}
                onUnassignedDragLeave={() => setHoverUnassigned(false)}
                handleStaffClick={handleStaffClick}
              />
              <RunsGridColumn
                runs={runs}
                selectedRunId={selectedRunId}
                onSelectRun={handleSelectRun}
                onRunsReorder={handleRunsReorder}
                onRunDropFromOutside={handleDropOnRunCard}
                onRunFlightDragStart={handleRunFlightDragStart}
                isDraggingUnassignedFlight={isDraggingUnassignedFlight}
                hoverRunId={hoverRunId}
                onRunCardDragEnter={setHoverRunId}
                onRunCardDragLeave={() => setHoverRunId(null)}
              />
              <RunSheetColumn
                runs={runs}
                selectedRunId={selectedRunId}
                onUpdateFlightRun={updateFlightRun}
              />
            </main>
          ) : (
            <section className="planner-staff-view">
              <div className="planner-staff-columns">
                <div className="planner-staff-roster">
                  <div className="planner-staff-header">
                    <h3>Rostered staff</h3>
                    {loadingStaffRuns && <span className="muted">Loading…</span>}
                  </div>
                  {staffViewError && (
                    <div className="planner-status planner-status--warn">
                      {staffViewError}
                    </div>
                  )}
                  {!staffViewError && !roster.length && !loadingStaffRuns && (
                    <div className="planner-status planner-status--warn">
                      No roster entries for this date.
                    </div>
                  )}
                  <ul>
                    {roster.map((shift) => {
                      const runList = staffRunsByStaffId.get(
                        shift.staff_id || shift.staffId
                      );
                      const assignedFlights =
                        runList?.reduce(
                          (acc, r) => acc + (Array.isArray(r.jobs) ? r.jobs.length : 0),
                          0
                        ) || 0;
                      const flightsLabel =
                        staffViewError || loadingStaffRuns ? "—" : assignedFlights;
                      const isSelected =
                        selectedStaffId === (shift.staff_id || shift.staffId);
                      return (
                        <li
                          key={shift.staff_id || shift.staffId}
                          className={isSelected ? "selected" : ""}
                          onClick={() =>
                            setSelectedStaffId(shift.staff_id || shift.staffId)
                          }
                        >
                          <div className="planner-staff-title">
                            <button
                              type="button"
                              className="link-button staff-link"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleStaffClick(
                                  shift.staff_code,
                                  shift.staff_name
                                );
                              }}
                            >
                              <strong>{shift.staff_name}</strong> ({shift.staff_code})
                            </button>
                          </div>
                          <div className="planner-staff-meta">
                            Shift {shift.start_local || "?"}–
                            {shift.end_local || "?"} · Flights: {flightsLabel}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div className="planner-staff-runs">
                  <h3>Staff runs</h3>
                  {!staffViewError &&
                    !loadingStaffRuns &&
                    (staffRuns.runs || []).length === 0 && (
                      <div className="planner-status planner-status--warn">
                        No runs generated yet for {airline} on {date}. Try
                        “Generate staff runs” to populate assignments.
                      </div>
                    )}
                  {!selectedStaff && (
                    <p className="muted">Select a rostered staff member.</p>
                  )}
                  {selectedStaff && (
                    <div className="planner-staff-detail">
                      <div className="planner-staff-detail-header">
                        <div>
                          <div className="planner-staff-title">
                            <button
                              type="button"
                              className="link-button staff-link"
                              onClick={() =>
                                handleStaffClick(
                                  selectedStaff.staff_code,
                                  selectedStaff.staff_name
                                )
                              }
                            >
                              <strong>{selectedStaff.staff_name}</strong> ({
                                selectedStaff.staff_code
                              })
                            </button>
                          </div>
                          <div className="planner-staff-meta">
                            Shift {selectedStaff.start_local || "?"}–
                            {selectedStaff.end_local || "?"}
                          </div>
                        </div>
                        <div className="planner-staff-meta">
                          Employment: {selectedStaff.employment_type || "n/a"}
                        </div>
                      </div>

                      {!selectedStaffRuns.length && (
                        <div className="planner-status planner-status--warn">
                          No flights assigned to this staff member.
                        </div>
                      )}

                      {selectedStaffRuns.map((run) => (
                        <div key={run.id} className="planner-staff-run-card">
                          <div className="planner-staff-run-header">
                            <div>
                              <strong>Run #{run.id}</strong>
                            </div>
                            <div className="planner-staff-meta">
                              {run.shift_start || "?"}–{run.shift_end || "?"}
                            </div>
                          </div>
                          <ul>
                            {(run.jobs || []).map((job) => (
                              <li key={`${run.id}-${job.sequence}`}>
                                <span className="planner-job-seq">{job.sequence + 1}.</span>
                                <span className="planner-job-flight">{job.flight_number || ""}</span>
                                <span className="planner-job-time">
                                  {formatLocalTimeLabel(job.etd_local)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="planner-unassigned-staff">
                <h4>
                  Unassigned flights ({(staffRuns.unassigned || []).length})
                </h4>
                {(staffRuns.unassigned || []).length === 0 ? (
                  <p className="muted">All flights are assigned to staff.</p>
                ) : (
                  <ul>
                    {(staffRuns.unassigned || []).map((f) => (
                      <li key={f.flight_id}>
                        <span className="planner-job-flight">{f.flight_number}</span>
                        <span className="planner-job-time">
                          {formatLocalTimeLabel(f.etd_local)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}
        </>
      )}

      <footer className="planner-footer">
        <div className="planner-summary">
          <span>
            <strong>Total flights:</strong> {summary.total}
          </span>
          <span>
            <strong>AM (05:00–12:00):</strong> {summary.am.total} [
            {formatByAirline(summary.am.byAirline)}]
          </span>
          <span>
            <strong>PM (12:01–23:00):</strong> {summary.pm.total} [
            {formatByAirline(summary.pm.byAirline)}]
          </span>
          <span>
            <strong>Unassigned:</strong> {unassignedCount}
          </span>
        </div>
      </footer>
      {renderStaffDayPanel()}
    </div>
  );
};

export default PlannerPage;
