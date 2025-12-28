import React, { useEffect, useMemo, useState } from "react";

const DEFAULT_DAYS = 4;
const DEFAULT_AIRPORT = "YSSY";

function DbInventoryCard() {
  const [airport, setAirport] = useState(DEFAULT_AIRPORT);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [airlines, setAirlines] = useState("ALL");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [inventory, setInventory] = useState(null);

  const airlineColumns = useMemo(() => {
    const columns = new Set();
    const rows = inventory?.days || [];
    rows.forEach((day) => {
      if (!day?.by_airline) return;
      Object.keys(day.by_airline).forEach((code) => columns.add(code));
    });
    return Array.from(columns).sort();
  }, [inventory]);

  const loadInventory = async () => {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      params.set("airport", airport.trim().toUpperCase());
      params.set("days", String(days));
      params.set("airlines", airlines.trim() || "ALL");

      const resp = await fetch(
        `/api/machine-room/db-flight-inventory?${params.toString()}`
      );
      const payload = await resp.json();

      if (!resp.ok || payload?.ok === false) {
        setError(payload?.error || "Failed to load DB inventory.");
        setInventory(null);
        return;
      }

      setInventory(payload);
    } catch (err) {
      console.error("Failed to fetch DB inventory", err);
      setError(err?.message || "Failed to load DB inventory.");
      setInventory(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadInventory();
  }, []);

  const rows = inventory?.days || [];

  return (
    <div className="machine-room-card">
      <div className="machine-room-status-header">
        <div>
          <h3>DB Inventory</h3>
          <p className="muted">
            Snapshot of flights stored in the Brain database (no upstream calls).
          </p>
        </div>
        <div className="machine-room-inventory-controls">
          <label>
            Airport
            <input
              type="text"
              value={airport}
              onChange={(event) => setAirport(event.target.value)}
              className="machine-room-inventory-input"
            />
          </label>
          <label>
            Days
            <select
              value={days}
              onChange={(event) =>
                setDays(Number.parseInt(event.target.value, 10))
              }
              className="machine-room-inventory-input"
            >
              {Array.from({ length: 14 }, (_, idx) => idx + 1).map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
          <label>
            Airlines
            <input
              type="text"
              value={airlines}
              onChange={(event) => setAirlines(event.target.value)}
              className="machine-room-inventory-input"
            />
          </label>
          <button
            type="button"
            className="machine-room-import-button"
            onClick={loadInventory}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="muted">Error: {error}</div>}

      {!error && rows.length === 0 && (
        <div className="muted">
          {loading ? "Loading inventory…" : "No DB flights found in range."}
        </div>
      )}

      {rows.length > 0 && (
        <div className="machine-room-inventory-table-wrapper">
          <table className="machine-room-inventory-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Total</th>
                {airlineColumns.map((code) => (
                  <th key={code}>{code}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{day.count}</td>
                  {airlineColumns.map((code) => (
                    <td key={`${day.date}-${code}`}>
                      {day.by_airline?.[code] ?? 0}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default DbInventoryCard;
