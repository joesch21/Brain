import React from "react";

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
  if (!startLabel && !endLabel) return "-";
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

const RunSheetSection = ({
  run,
  date,
  airport,
  index,
  sectionId,
  className = "",
  showFooter = true,
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
          <span className="runsheet-label">Window</span>
          <span>{formatWindow(startTime, endTime)}</span>
        </div>
      </div>

      <table className="runsheet-table">
        <thead>
          <tr>
            <th>Flight</th>
            <th>STD/STA</th>
            <th>Bay/Stand</th>
            <th>Operator</th>
            <th>Destination/Origin</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {flights.length === 0 ? (
            <tr>
              <td colSpan={6} className="runsheet-table__empty">
                No flights in run.
              </td>
            </tr>
          ) : (
            flights.map((flightRun, rowIndex) => {
              const flight = flightRun?.flight || flightRun;
              const flightNumber = getFlightValue(flight, flightRun, [
                "flight_number",
                "flightNumber",
                "flight_no",
                "ident",
                "callsign",
              ]);
              const std = getFlightValue(flight, flightRun, [
                "std",
                "scheduled_time",
                "scheduled_off",
                "scheduled_departure",
                "departure_time",
                "dep_time",
                "time_local",
                "timeLocal",
              ]);
              const sta = getFlightValue(flight, flightRun, [
                "sta",
                "scheduled_on",
                "scheduled_arrival",
                "arrival_time",
                "arr_time",
                "eta",
              ]);
              const bay = getFlightValue(flight, flightRun, [
                "bay",
                "stand",
                "gate",
              ]);
              const operatorCode = getFlightValue(flight, flightRun, [
                "operator",
                "operator_code",
                "airline",
                "carrier",
              ]);
              const destination = getFlightValue(flight, flightRun, [
                "destination",
                "dest",
                "origin",
                "orig",
              ]);
              const notes = getFlightValue(flight, flightRun, [
                "notes",
                "note",
                "comment",
                "remarks",
              ]);
              const timeLabel = [std, sta].filter(Boolean).join(" / ");

              return (
                <tr key={flightRun?.id ?? flight?.id ?? rowIndex}>
                  <td>{displayValue(flightNumber)}</td>
                  <td>{displayValue(timeLabel)}</td>
                  <td>{displayValue(bay)}</td>
                  <td>{displayValue(operatorCode)}</td>
                  <td>{displayValue(destination)}</td>
                  <td>{displayValue(notes)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {showFooter && (
        <footer className="runsheet-footer">
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
