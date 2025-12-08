import React from "react";
import BackendDebugConsole from "../components/BackendDebugConsole";

// Explanatory Wiring page plus the live backend debug panel.
const WiringTestPage = () => {
  return (
    <main style={{ padding: "1.5rem" }}>
      <h1>Wiring Test</h1>
      <p>
        This page is used to check that The Brain can reach the CodeCrafter2 backend
        and that environment variables and endpoints are wired correctly.
      </p>
      <p>
        The panel below calls <code>/api/wiring-status</code> on the Ops backend and shows
        a simple list of checks so we can verify that the wiring is alive in production.
      </p>

      <BackendDebugConsole />
    </main>
  );
};

export default WiringTestPage;
