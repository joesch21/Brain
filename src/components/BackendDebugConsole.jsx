// /src/components/BackendDebugConsole.jsx
import React, { useEffect, useState, useRef } from "react";

export default function BackendDebugConsole() {
  const [debug, setDebug] = useState(window.backendDebug);
  const [collapsed, setCollapsed] = useState(false);

  const boxRef = useRef(null);
  const dragState = useRef({ dragging: false, offsetX: 0, offsetY: 0 });

  useEffect(() => {
    const interval = setInterval(() => {
      setDebug({ ...window.backendDebug });
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const startDrag = (e) => {
    dragState.current.dragging = true;
    const rect = boxRef.current.getBoundingClientRect();
    dragState.current.offsetX = e.clientX - rect.left;
    dragState.current.offsetY = e.clientY - rect.top;
  };

  const stopDrag = () => {
    dragState.current.dragging = false;
  };

  const onDrag = (e) => {
    if (!dragState.current.dragging) return;
    boxRef.current.style.left = `${e.clientX - dragState.current.offsetX}px`;
    boxRef.current.style.top = `${e.clientY - dragState.current.offsetY}px`;
  };

  useEffect(() => {
    window.addEventListener("mousemove", onDrag);
    window.addEventListener("mouseup", stopDrag);
    return () => {
      window.removeEventListener("mousemove", onDrag);
      window.removeEventListener("mouseup", stopDrag);
    };
  }, []);

  const entries = Array.isArray(debug?.entries)
    ? debug.entries
    : debug
    ? [debug]
    : [];

  if (!entries.length) return null;

  const latest = entries[entries.length - 1];

  return (
    <div
      ref={boxRef}
      style={{
        position: "fixed",
        bottom: "20px",
        right: "20px",
        width: collapsed ? "200px" : "420px",
        height: collapsed ? "40px" : "auto",
        background: "rgba(0,0,0,0.85)",
        color: "white",
        padding: "10px",
        borderRadius: "8px",
        zIndex: 999999,
        cursor: "move",
        userSelect: "none",
      }}
      onMouseDown={startDrag}
    >
      <div
        style={{
          fontWeight: "bold",
          color: "#ff8080",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        ⚠ Backend Debug
        {latest?.type && (
          <span style={{ fontSize: "11px", marginLeft: "8px", color: "#ffd1d1" }}>
            {latest.type}
          </span>
        )}
        <button
          style={{
            marginLeft: "10px",
            background: "transparent",
            border: "none",
            color: "white",
            cursor: "pointer",
          }}
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed(!collapsed);
          }}
        >
          {collapsed ? "🔽" : "🔼"}
        </button>
      </div>

      {!collapsed && (
        <div
          style={{
            fontSize: "11px",
            marginTop: "8px",
            maxHeight: "300px",
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: "6px",
          }}
        >
          {[...entries].reverse().map((entry, idx) => (
            <div
              key={idx}
              style={{
                padding: "6px",
                background: "rgba(255, 255, 255, 0.04)",
                borderRadius: "6px",
                border: "1px solid rgba(255, 255, 255, 0.08)",
              }}
            >
              <div style={{ marginBottom: "4px" }}>
                <strong>{entry.type || "log"}</strong>
                {entry.timestamp && (
                  <span style={{ marginLeft: "6px", opacity: 0.8 }}>
                    {entry.timestamp}
                  </span>
                )}
                {entry.url && (
                  <div style={{ fontSize: "10px", opacity: 0.8 }}>{entry.url}</div>
                )}
              </div>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: "10px",
                  margin: 0,
                }}
              >
                {JSON.stringify(entry, null, 2)}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
