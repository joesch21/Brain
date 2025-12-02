import React, { useEffect, useState } from "react";

export default function BackendDebugConsole() {
  const [debug, setDebug] = useState(window.backendDebug);

  useEffect(() => {
    const interval = setInterval(() => {
      setDebug(window.backendDebug);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!debug) return null;

  return (
    <div style={{
      position: "fixed",
      bottom: "20px",
      right: "20px",
      background: "rgba(0,0,0,0.85)",
      color: "white",
      padding: "14px 18px",
      maxWidth: "420px",
      borderRadius: "8px",
      fontFamily: "monospace",
      zIndex: 999999
    }}>
      <strong style={{ color: "#ff8080" }}>⚠ Backend Error</strong>
      <pre style={{ whiteSpace: "pre-wrap", fontSize: "11px", marginTop: "8px" }}>
        {JSON.stringify(debug, null, 2)}
      </pre>
    </div>
  );
}
