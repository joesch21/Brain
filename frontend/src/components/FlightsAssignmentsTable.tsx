import React from "react";
import type { AssignedFlight } from "../api/opsClient";

// EWOT: renders a simple table of flights with assigned staff & highlights unassigned ones.

interface Props {
  flights: AssignedFlight[];
}

export const FlightsAssignmentsTable: React.FC<Props> = ({ flights }) => {
  if (!flights.length) {
    return <p>No flights loaded for this date.</p>;
  }

  const unassignedCount = flights.filter(
    (f) => !f.assigned_staff_name
  ).length;

  return (
    <div>
      <p style={{ marginBottom: "0.5rem" }}>
        <strong>Unassigned flights:</strong> {unassignedCount}
      </p>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Flight</th>
              <th style={{ textAlign: "left" }}>Airline</th>
              <th style={{ textAlign: "left" }}>Route</th>
              <th style={{ textAlign: "left" }}>Time</th>
              <th style={{ textAlign: "left" }}>Assigned staff</th>
            </tr>
          </thead>
          <tbody>
            {flights.map((f) => {
              const unassigned = !f.assigned_staff_name;
              const staffLabel = f.assigned_staff_label;
              const staffInitials = f.assigned_staff_initials;
              const staffDisplay = unassigned
                ? ""
                : `${
                    staffInitials ||
                    f.assigned_staff_name ||
                    f.assigned_staff_code ||
                    staffLabel ||
                    ""
                  }${staffLabel ? ` (${staffLabel})` : f.assigned_staff_code ? ` (${f.assigned_staff_code})` : ""}`;
              return (
                <tr
                  key={f.id}
                  style={{
                    backgroundColor: unassigned ? "#ffe6e6" : "transparent",
                  }}
                >
                  <td>{f.flight_number}</td>
                  <td>{f.operator_code || ""}</td>
                  <td>
                    {f.origin} → {f.destination}
                  </td>
                  <td>{f.time_local || ""}</td>
                  <td>
                    {unassigned ? (
                      <span style={{ color: "#c00" }}>Unassigned</span>
                    ) : (
                      staffDisplay
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
