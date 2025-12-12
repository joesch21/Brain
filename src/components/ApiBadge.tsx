import React from "react";

import { API_BASE, API_HOST } from "../api/apiBase";

const badgeStyle: React.CSSProperties = {
  position: "fixed",
  bottom: "12px",
  right: "12px",
  padding: "6px 10px",
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  color: "#e0e0e0",
  borderRadius: 6,
  fontSize: "12px",
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  boxShadow: "0 2px 6px rgba(0,0,0,0.25)",
  zIndex: 999,
};

const ApiBadge: React.FC = () => {
  const host = API_HOST || API_BASE;

  return (
    <div style={badgeStyle} title={`API base: ${API_BASE}`}>
      API: <strong style={{ color: "#9ad6ff" }}>{host}</strong>
    </div>
  );
};

export default ApiBadge;
