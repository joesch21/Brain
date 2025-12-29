import React, { useMemo } from "react";

export function displayValue(value, fallback = "-") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function getRunId(run) {
  return (
    run?.id ??
    run?.run_id ??
    run?.runId ??
    run?.run_no ??
    run?.runNo ??
    run?.number ??
    null
  );
}

export function getRunFlights(run) {
  const flights = run?.flights || run?.flight_runs || run?.flightRuns || run?.items;
  return Array.isArray(flights) ? flights : [];
}

export function formatWindow(start, end) {
  const startLabel = displayValue(start, "");
  const endLabel = displayValue(end, "");
  if (!startLabel && !endLabel) return "Unknown";
  if (startLabel && endLabel) return `${startLabel} – ${endLabel}`;
  return startLabel || endLabel;
}

export function getFlightValue(flight, runFlight, keys) {
  for (const key of keys) {
    if (runFlight && runFlight[key] != null && runFlight[key] !== "") {
      return runFlight[key];
    }
    if (flight && flight[key] != null && flight[key] !== "") {
      return flight[key];
    }
  }
  return "";
}

function getAssignmentKey(entry) {
  if (!entry) return null;
  return (
    entry.flight_id ??
    entry.flightId ??
    entry.flightID ??
    entry.flight_number ??
    entry.flightNumber ??
    entry.flight_no ??
    entry.flightNo ??
    null
  );
}

function getFlightKey(flight, runFlight) {
  if (!flight && !runFlight) return null;
  return (
    runFlight?.flight_id ??
    runFlight?.flightId ??
    flight?.id ??
    flight?.flight_id ??
    runFlight?.flight_number ??
    runFlight?.flightNumber ??
    runFlight?.flight_no ??
    flight?.flight_number ??
    flight?.flightNumber ??
    flight?.flight_no ??
    null
  );
}

function formatStaffAssignment(assignment) {
  if (!assignment) return null;
  const name =
    assignment.staff_name ||
    assignment.staffName ||
    assignment.staff_code ||
    assignment.staffCode ||
    assignment.staff_initials ||
    assignment.staffInitials ||
    assignment.staff_label ||
    assignment.name ||
    "";
  if (!name) return null;
  const role =
    assignment.role ||
    assignment.role_label ||
    assignment.staff_role ||
    assignment.staffRole ||
    assignment.staff_label ||
    assignment.label ||
    "";
  if (role && role !== name) return `${role}: ${name}`;
  return name;
}

function buildRunStaffList(run, assignments) {
  const flights = getRunFlights(run);
  if (!flights.length || !Array.isArray(assignments) || assignments.length === 0) {
    return [];
  }

  const assignmentsByFlight = new Map();
  for (const assignment of assignments) {
    const key = getAssignmentKey(assignment);
    if (key == null) continue;
    const normalizedKey = String(key);
    const existing = assignmentsByFlight.get(normalizedKey) || [];
    existing.push(assignment);
    assignmentsByFlight.set(normalizedKey, existing);
  }

  const staffSet = new Set();
  const staffList = [];

  for (const flightRun of flights) {
    const flight = flightRun?.flight || flightRun;
    const flightKey = getFlightKey(flight, flightRun);
    if (flightKey == null) continue;
    const matches = assignmentsByFlight.get(String(flightKey)) || [];
    for (const assignment of matches) {
      const label = formatStaffAssignment(assignment);
      if (!label || staffSet.has(label)) continue;
      staffSet.add(label);
      staffList.push(label);
    }
  }

  return staffList;
}

const SERVICE_TIME_KEYS = [
  "planned_service_time",
  "plannedServiceTime",
  "service_time",
  "serviceTime",
  "planned_time",
  "plannedTime",
  "fuel_time",
  "fuelTime",
];

const STD_STA_KEYS = [
  "std",
  "scheduled_time",
  "scheduled_off",
  "scheduled_departure",
  "departure_time",
  "dep_time",
  "time_local",
  "timeLocal",
  "sta",
  "scheduled_on",
  "scheduled_arrival",
  "arrival_time",
  "arr_time",
  "eta",
];

const GROUP_PRIMARY_KEYS = ["bay", "stand", "gate"];
const GROUP_FALLBACK_KEYS = [
  "terminal",
  "terminal_area",
  "terminalArea",
  "gate_area",
  "gateArea",
  "area",
];

function toSortableTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  const raw = String(value).trim();
  const match = raw.match(/(\d{1,2}):(\d{2})/);
  if (match && !raw.includes("T") && !raw.includes("-")) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isNaN(hours) && !Number.isNaN(minutes)) {
      return hours * 60 + minutes;
    }
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 60000);
  if (match) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (!Number.isNaN(hours) && !Number.isNaN(minutes)) {
      return hours * 60 + minutes;
    }
  }
  return null;
}

function getServiceTime(flight, runFlight) {
  const primary = getFlightValue(flight, runFlight, SERVICE_TIME_KEYS);
  if (primary) {
    return { label: primary, sortValue: toSortableTime(primary), source: "service" };
  }
  const fallback = getFlightValue(flight, runFlight, STD_STA_KEYS);
  const std = getFlightValue(flight, runFlight, [
    "std",
    "scheduled_time",
    "scheduled_off",
    "scheduled_departure",
    "departure_time",
    "dep_time",
    "time_local",
    "timeLocal",
  ]);
  const sta = getFlightValue(flight, runFlight, [
    "sta",
    "scheduled_on",
    "scheduled_arrival",
    "arrival_time",
    "arr_time",
    "eta",
  ]);
  const combined = [std, sta].filter(Boolean).join(" / ");
  return {
    label: combined || fallback,
    sortValue: toSortableTime(fallback || combined),
    source: fallback ? "std" : "unknown",
  };
}

function getGroupLabel(flight, runFlight) {
  const primary = getFlightValue(flight, runFlight, GROUP_PRIMARY_KEYS);
  if (primary) return primary;
  const fallback = getFlightValue(flight, runFlight, GROUP_FALLBACK_KEYS);
  return fallback || "Unassigned";
}

const RunSheetSection = ({
  run,
  date,
  airport,
  index,
  sectionId,
  className = "",
  showFooter = true,
  assignmentsStatus = "idle",
  assignments = [],
}) => {
  const runId = getRunId(run);
  const shiftLabel =
    run?.shift_label || run?.shift?.label || run?.shift || run?.shift_code || "";
  const truck =
    run?.truck_label || run?.truck_code || run?.truck_id || run?.truck || "";
  const runLabel = run?.label || run?.run_label || "";

  const startTime =
    run?.start_time ||
    run?.startTime ||
    run?.shift?.start_time ||
    run?.shift?.startTime ||
    "";
  const endTime =
    run?.end_time ||
    run?.endTime ||
    run?.shift?.end_time ||
    run?.shift?.endTime ||
    "";

  const volume =
    run?.estimated_volume ||
    run?.estimated_volume_l ||
    run?.volume ||
    run?.total_volume ||
    run?.volume_litres ||
    "";

  const flights = getRunFlights(run);
  const totalFlights = flights.length;

  const enrichedFlights = flights.map((flightRun, rowIndex) => {
    const flight = flightRun?.flight || flightRun;
    const flightNumber = getFlightValue(flight, flightRun, [
      "flight_number",
      "flightNumber",
      "flight_no",
      "ident",
      "callsign",
    ]);
    const serviceTime = getServiceTime(flight, flightRun);
    const bay = getFlightValue(flight, flightRun, GROUP_PRIMARY_KEYS);
    const operatorCode = getFlightValue(flight, flightRun, [
      "operator",
      "operator_code",
      "airline",
      "carrier",
    ]);
    const origin = getFlightValue(flight, flightRun, ["origin", "orig"]);
    const destination = getFlightValue(flight, flightRun, ["destination", "dest"]);
    const route = [origin, destination].filter(Boolean).join(" → ");
    const fuel = getFlightValue(flight, flightRun, [
      "fuel",
      "fuel_qty",
      "fuelQty",
      "qty",
      "quantity",
      "uplift",
    ]);
    const notes = getFlightValue(flight, flightRun, [
      "notes",
      "note",
      "comment",
      "remarks",
    ]);

    return {
      flightRun,
      flight,
      rowIndex,
      flightNumber,
      serviceTime,
      bay,
      operatorCode,
      route,
      fuel,
      notes,
      groupLabel: getGroupLabel(flight, flightRun),
    };
  });

  const sortedFlights = [...enrichedFlights].sort((a, b) => {
    const aValue = a.serviceTime.sortValue;
    const bValue = b.serviceTime.sortValue;
    if (aValue == null && bValue == null) return a.rowIndex - b.rowIndex;
    if (aValue == null) return 1;
    if (bValue == null) return -1;
    if (aValue === bValue) return a.rowIndex - b.rowIndex;
    return aValue - bValue;
  });

  const groupedFlights = sortedFlights.reduce((acc, item) => {
    if (!acc[item.groupLabel]) {
      acc[item.groupLabel] = [];
    }
    acc[item.groupLabel].push(item);
    return acc;
  }, {});

  const groupedEntries = Object.entries(groupedFlights);

  const sortedTimeLabels = sortedFlights
    .map((item) => item.serviceTime.label)
    .filter(Boolean);
  const runWindowStart = sortedTimeLabels[0] || "";
  const runWindowEnd = sortedTimeLabels[sortedTimeLabels.length - 1] || "";
  const hasServiceTime = sortedFlights.some(
    (item) => item.serviceTime.source === "service",
  );
  const hasFallbackTime = sortedFlights.some(
    (item) => item.serviceTime.source === "std",
  );
  const sortKeyLabel = hasServiceTime
    ? "Sorted by Service Time"
    : hasFallbackTime
      ? "Sorted by STD/STA"
      : "Sorted by Service Time (Unknown)";

  const staffList = useMemo(() => {
    if (assignmentsStatus !== "loaded") return [];
    return buildRunStaffList(run, assignments);
  }, [assignments, assignmentsStatus, run]);

  const staffDisplay = useMemo(() => {
    if (assignmentsStatus === "loading") {
      return { text: "Loading staff…", muted: true };
    }
    if (assignmentsStatus === "loaded") {
      if (staffList.length === 0) {
        return { text: "(unassigned)", muted: true };
      }
      return { text: staffList.join(", "), muted: false };
    }
    return { text: "(unavailable)", muted: true };
  }, [assignmentsStatus, staffList]);

  const sectionClassName = ["runsheet-card", className]
    .filter(Boolean)
    .join(" ");

  return (
    <section id={sectionId} className={sectionClassName}>
      <header className="runsheet-header">
        <div className="runsheet-header-main">
          <div className="runsheet-title">
            {runLabel || (runId != null ? `Run ${runId}` : `Run ${index + 1}`)}
          </div>
          <div className="runsheet-subtitle">
            {displayValue(date)} · {displayValue(airport)}
          </div>
        </div>
        <div className="runsheet-header-meta">
          <div>
            <span className="runsheet-label">Shift</span>
            <span>{displayValue(shiftLabel)}</span>
          </div>
          <div>
            <span className="runsheet-label">Truck</span>
            <span>{displayValue(truck)}</span>
          </div>
          <div>
            <span className="runsheet-label">Run #</span>
            <span>{displayValue(runId ?? index + 1)}</span>
          </div>
          <div className="runsheet-staff">
            <span className="runsheet-label">Staff</span>
            <span className={staffDisplay.muted ? "runsheet-staff--muted" : ""}>
              {staffDisplay.text}
            </span>
          </div>
        </div>
      </header>

      <div className="runsheet-summary">
        <div>
          <span className="runsheet-label">Total flights</span>
          <span>{displayValue(totalFlights)}</span>
        </div>
        <div>
          <span className="runsheet-label">Estimated volume</span>
          <span>{displayValue(volume)}</span>
        </div>
        <div>
          <span className="runsheet-label">Run window</span>
          <span>{formatWindow(runWindowStart || startTime, runWindowEnd || endTime)}</span>
        </div>
        <div>
          <span className="runsheet-label">Sort key</span>
          <span>{sortKeyLabel}</span>
        </div>
      </div>

      {flights.length === 0 ? (
        <table className="runsheet-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Flight</th>
              <th>Stand/Bay</th>
              <th>Operator</th>
              <th>Route</th>
              <th>Fuel/Qty</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={7} className="runsheet-table__empty">
                No flights in run.
              </td>
            </tr>
          </tbody>
        </table>
      ) : (
        groupedEntries.map(([groupLabel, items]) => (
          <div key={groupLabel} className="runsheet-group">
            <div className="runsheet-group-header">
              <span className="runsheet-group-title">
                Stand/Bay: {displayValue(groupLabel, "Unassigned")}
              </span>
              <span className="runsheet-group-count">
                {items.length} {items.length === 1 ? "flight" : "flights"}
              </span>
            </div>
            <table className="runsheet-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Flight</th>
                  <th>Stand/Bay</th>
                  <th>Operator</th>
                  <th>Route</th>
                  <th>Fuel/Qty</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.flightRun?.id ?? item.flight?.id ?? item.rowIndex}>
                    <td className="runsheet-field--strong">
                      {displayValue(item.serviceTime.label)}
                    </td>
                    <td className="runsheet-field--strong">
                      {displayValue(item.flightNumber)}
                    </td>
                    <td className="runsheet-field--strong">
                      {displayValue(item.bay)}
                    </td>
                    <td>{displayValue(item.operatorCode)}</td>
                    <td>{displayValue(item.route)}</td>
                    <td>{displayValue(item.fuel)}</td>
                    <td>{displayValue(item.notes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="runsheet-group-notes">
              <span className="runsheet-label">Group notes</span>
              <span className="runsheet-line" />
              <span className="runsheet-line" />
            </div>
          </div>
        ))
      )}

      {showFooter && (
        <footer className="runsheet-footer">
          <div className="runsheet-run-notes">
            <span className="runsheet-label">Run notes</span>
            <span className="runsheet-line" />
            <span className="runsheet-line" />
            <span className="runsheet-line" />
          </div>
          <div className="runsheet-footer-meta">
            Generated {new Date().toLocaleString()}
          </div>
          <div className="runsheet-signatures">
            <div>
              <span className="runsheet-label">Driver signature</span>
              <span className="runsheet-line" />
            </div>
            <div>
              <span className="runsheet-label">Supervisor</span>
              <span className="runsheet-line" />
            </div>
            <div>
              <span className="runsheet-label">Notes</span>
              <span className="runsheet-line" />
            </div>
          </div>
        </footer>
      )}
    </section>
  );
};

export default RunSheetSection;
