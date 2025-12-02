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

  if (!debug) return null;

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
        <pre
          style={{
            whiteSpace: "pre-wrap",
            fontSize: "11px",
            marginTop: "8px",
            maxHeight: "300px",
            overflowY: "auto",
          }}
        >
          {JSON.stringify(debug, null, 2)}
        </pre>
      )}
    </div>
  );
}
