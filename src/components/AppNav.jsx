import React, { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import "../styles/appNav.css";

// Preserve your existing active class logic
const navLinkClass = ({ isActive }) =>
  "main-nav__link" + (isActive ? " active" : "");

const AppNav = () => {
  const [hasBackendError, setHasBackendError] = useState(!!window.backendDebug);

  // Poll global backend error state every 500ms
  useEffect(() => {
    const interval = setInterval(() => {
      setHasBackendError(!!window.backendDebug);
    }, 500);
    return () => clearInterval(interval);
  }, []);

  // Simple badge style (non-intrusive)
  const badge = hasBackendError ? (
    <span
      style={{
        backgroundColor: "red",
        color: "white",
        borderRadius: "50%",
        display: "inline-block",
        width: "10px",
        height: "10px",
        marginLeft: "6px",
      }}
    ></span>
  ) : null;

  return (
    <nav className="main-nav">
      <a className="main-nav__back" href="/">
        ← Back to Office
      </a>

      <div className="main-nav__links">
        <NavLink to="/planner" className={navLinkClass}>
          Planner {badge}
        </NavLink>

        <NavLink to="/schedule" className={navLinkClass}>
          Schedule {badge}
        </NavLink>

        <NavLink to="/runsheets" className={navLinkClass}>
          Run Sheets {badge}
        </NavLink>

        <NavLink to="/machine-room" className={navLinkClass}>
          Machine Room {badge}
        </NavLink>

        <NavLink to="/debug/wiring" className={navLinkClass}>
          Wiring {badge}
        </NavLink>
      </div>
    </nav>
  );
};

export default AppNav;
