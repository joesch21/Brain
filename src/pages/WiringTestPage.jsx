import React from "react";
import WiringTestPanel from "../components/WiringTestPanel";

const WiringTestPage = () => {
  return (
    <div style={{ padding: "1.5rem" }}>
      <h1>Debug – Wiring</h1>
      <p>
        This page checks that the Brain is talking to the correct CodeCrafter2
        backend and shows how CC2 is wired to its DB and Ops API.
      </p>
      <WiringTestPanel />
    </div>
  );
};

export default WiringTestPage;
