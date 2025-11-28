import React from "react";
import MachineRoomStatusCard from "../components/MachineRoomStatusCard";
import "../styles/machineRoom.css";

const primaryFlows = [
  "Build: plan and generate implementation tasks via the Build orchestrator",
  "Fix: review and apply automated fixes with the Fix service",
  "Know: answer operational questions through the Knowledge service",
  "Office manager dashboards: roster, schedule, and maintenance views",
  "Machine Room: supervisor overview of database metrics and audit history",
];

const completedWorkOrders = [
  { id: "CWO-BUILD-01", title: "Wire Build/Fix/Know flows to orchestrator, fixer, and knowledge services", status: "complete" },
  { id: "CWO-MR-01", title: "Machine Room reporting for employees, flights, maintenance, and audit logs", status: "complete" },
  { id: "CWO-IMPORT-01", title: "CSV/JSON import pipeline for roster and flight data", status: "complete" },
];

function MachineRoomPage() {
  return (
    <div className="machine-room-page">
      <h2>Machine Room</h2>
      <p className="machine-room-intro">
        Quick system snapshot for supervisors and admins.
      </p>

      {/* EWOT: This card shows backend/DB health, flight & run counts, and buttons to test APIs and seed demo flights. */}
      <MachineRoomStatusCard />

      <div className="machine-room-grid">
        <div className="machine-room-card">
          <h3>Project</h3>
          <p>
            <strong>Name:</strong> The Brain
          </p>
          <p>
            <strong>Status:</strong> operational
          </p>
          <p className="muted">
            Flask-based control center for Build, Fix, and Know flows with an office manager demo dataset.
          </p>

          <h4>Primary flows</h4>
          <ul>
            {primaryFlows.map((flow) => (
              <li key={flow}>{flow}</li>
            ))}
          </ul>
        </div>

        <div className="machine-room-card">
          <h3>Work orders</h3>
          <ul>
            {completedWorkOrders.map((wo) => (
              <li key={wo.id}>
                <strong>{wo.id}</strong>
                {wo.title ? ` — ${wo.title}` : ""}
                {wo.status ? <span className="muted"> ({wo.status})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export default MachineRoomPage;
