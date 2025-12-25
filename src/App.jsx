import React, { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import AppNav from "./components/AppNav";
import PlannerPage from "./pages/PlannerPage";
import MachineRoomPage from "./pages/MachineRoomPage";
import SchedulePage from "./pages/SchedulePage";
import RunSheetsPage from "./pages/RunSheetsPage";
import RunSheetsPackPage from "./pages/RunSheetsPackPage";
import RunsOverviewPage from "./pages/RunsOverviewPage";
import RunSheetTable from "./pages/RunSheetTable";

import BackendDebugConsole from "./components/BackendDebugConsole";
import WiringTestPage from "./pages/WiringTestPage";
import WiringDebugPage from "./pages/WiringDebugPage";
import ApiBadge from "./components/ApiBadge";
import { loadApiContract } from "./api/opsContractClient";

const App = () => {
  const [contractError, setContractError] = useState(null);

  useEffect(() => {
    loadApiContract().catch((err) => {
      console.error(err);
      setContractError("API contract could not be loaded. Some features may be unavailable.");
    });
  }, []);

  return (
    <BrowserRouter>
      <AppNav />

      <div style={{ paddingTop: "70px" }}>
        {contractError ? (
          <div
            style={{
              background: "#fdecea",
              border: "1px solid #f5c2c0",
              borderRadius: "6px",
              color: "#7a1c19",
              margin: "0 20px 12px",
              padding: "10px 12px",
            }}
          >
            {contractError}
          </div>
        ) : null}
        <Routes>
          <Route path="/planner" element={<PlannerPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/runs" element={<RunsOverviewPage />} />
          <Route path="/runsheets" element={<RunSheetsPage />} />
          <Route path="/runsheets/pack" element={<RunSheetsPackPage />} />

          {/* Single-run table view */}
          <Route path="/run-sheet" element={<RunSheetTable />} />

          <Route path="/machine-room" element={<MachineRoomPage />} />
          <Route path="/machine-room/wiring" element={<WiringTestPage />} />
          <Route path="/debug/wiring" element={<WiringTestPage />} />
          <Route path="/wiring" element={<WiringDebugPage />} />
          <Route path="*" element={<Navigate to="/planner" replace />} />
        </Routes>
      </div>

      <BackendDebugConsole />
      <ApiBadge />
    </BrowserRouter>
  );
};

export default App;
