import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import AppNav from "./components/AppNav";
import PlannerPage from "./pages/PlannerPage";
import MachineRoomPage from "./pages/MachineRoomPage";
import SchedulePage from "./pages/SchedulePage";
import RunSheetsPage from "./pages/RunSheetsPage";

const App = () => {
  return (
    <BrowserRouter>
      <AppNav />
      <Routes>
        <Route path="/planner" element={<PlannerPage />} />
        <Route path="/schedule" element={<SchedulePage />} />
        <Route path="/runsheets" element={<RunSheetsPage />} />
        <Route path="/machine-room" element={<MachineRoomPage />} />
        <Route path="*" element={<Navigate to="/planner" replace />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
