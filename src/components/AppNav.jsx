import React from "react";
import { NavLink } from "react-router-dom";
import "../styles/appNav.css";

const navLinkClass = ({ isActive }) =>
  "main-nav__link" + (isActive ? " active" : "");

const AppNav = () => {
  return (
    <nav className="main-nav">
      <NavLink to="/planner" className={navLinkClass}>
        Planner
      </NavLink>
      <NavLink to="/schedule" className={navLinkClass}>
        Schedule
      </NavLink>
      <NavLink to="/runsheets" className={navLinkClass}>
        Run Sheets
      </NavLink>
      <NavLink to="/machine-room" className={navLinkClass}>
        Machine Room
      </NavLink>
    </nav>
  );
};

export default AppNav;
