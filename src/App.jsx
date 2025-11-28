import React from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import PlannerPage from "./pages/PlannerPage";

const App = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/planner" element={<PlannerPage />} />
        <Route path="*" element={<Navigate to="/planner" replace />} />
      </Routes>
    </BrowserRouter>
  );
};

export default App;
