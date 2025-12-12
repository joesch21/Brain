import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import AppNav from "./components/AppNav";
import PlannerPage from "./pages/PlannerPage";
import MachineRoomPage from "./pages/MachineRoomPage";
import SchedulePage from "./pages/SchedulePage";
import RunSheetsPage from "./pages/RunSheetsPage";
import RunsOverviewPage from "./pages/RunsOverviewPage";

import BackendDebugConsole from "./components/BackendDebugConsole";
import WiringTestPage from "./pages/WiringTestPage";
import WiringDebugPage from "./pages/WiringDebugPage";
import ApiBadge from "./components/ApiBadge";

const App = () => {
  return (
    <BrowserRouter>
      {/* Global Navigation */}
      <AppNav />

      {/* Main App Content */}
      <div style={{ paddingTop: "70px" }}>
        <Routes>
          <Route path="/planner" element={<PlannerPage />} />
          <Route path="/schedule" element={<SchedulePage />} />
          <Route path="/runs" element={<RunsOverviewPage />} />
          <Route path="/runsheets" element={<RunSheetsPage />} />
          <Route path="/machine-room" element={<MachineRoomPage />} />
          <Route path="/debug/wiring" element={<WiringTestPage />} />
          <Route path="/wiring" element={<WiringDebugPage />} />
          <Route path="*" element={<Navigate to="/planner" replace />} />
        </Routes>
      </div>

      {/* 🔥 Backend Debug Console — ALWAYS VISIBLE */}
      <BackendDebugConsole />

      {/* Small footer badge showing which API host the UI is wired to */}
      <ApiBadge />
    </BrowserRouter>
  );
};

export default App;
