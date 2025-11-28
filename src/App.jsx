import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import PlannerPage from "./pages/PlannerPage";
import MachineRoomPage from "./pages/MachineRoomPage";

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/planner" element={<PlannerPage />} />
        <Route path="/machine-room" element={<MachineRoomPage />} />
        <Route path="*" element={<Navigate to="/planner" replace />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
