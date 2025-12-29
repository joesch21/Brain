// src/pages/RunSheetTable.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { apiUrl } from "../lib/apiBase";
import "../index.css";

function getQueryParam(name) {
  try {
    const url = new URL(window.location.href);
    return url.searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function fmt(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  return String(v);
}

function todayISO() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtTime(isoOrText) {
  const s = fmt(isoOrText);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

export default function RunSheetTable() {
  const initialRunId = useMemo(() => {
    return getQueryParam("run_id") || getQueryParam("id");
  }, []);

  const initialDate = useMemo(() => {
    return getQueryParam("date") || todayISO();
  }, []);

  const autoPrint = useMemo(() => getQueryParam("print") === "1", []);
  const printTriggeredRef = useRef(false);

  const [runId, setRunId] = useState(initialRunId || "");
  const [date, setDate] = useState(initialDate || "");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  async function loadSheet(id, dt) {
    const rid = (id || "").trim();
    const d = (dt || "").trim();

    if (!rid) {
      setErr("Enter a run id.");
      setData(null);
      return;
    }

    if (!d) {
      setErr("Enter a date.");
      setData(null);
      return;
    }

    setLoading(true);
    setErr("");
    setData(null);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    try {
      const url = apiUrl(`/api/runs/sheet?run_id=${encodeURIComponent(
        rid
      )}&date=${encodeURIComponent(d)}`);
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(
          `HTTP ${res.status} ${res.statusText}${txt ? ` — ${txt}` : ""}`
        );
      }

      const json = await res.json();
      if (!json || json.ok === false) {
        throw new Error(json?.error?.message || "Run sheet returned ok=false");
      }

      setData(json);
    } catch (e) {
      const msg =
        e?.name === "AbortError"
          ? "Request timed out (possible Render cold start). Try again."
          : e?.message || "Failed to load run sheet.";
      setErr(msg);
    } finally {
      clearTimeout(timeout);
      setLoading(false);
    }
  }

  useEffect(() => {
    if (initialRunId) loadSheet(initialRunId, initialDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!autoPrint || !data || printTriggeredRef.current) return;
    printTriggeredRef.current = true;
    const timer = setTimeout(() => window.print(), 400);
    return () => clearTimeout(timer);
  }, [autoPrint, data]);

  const header = data?.header || data?.run || {};
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.rows)
    ? data.rows
    : [];
  const counts = data?.counts || {};

  return (
    <div
      className="runsheet"
      style={{ padding: 16, maxWidth: 1100, margin: "0 auto" }}
    >
      <h2 style={{ marginBottom: 8 }}>Run Sheet</h2>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
        <label style={{ minWidth: 60 }}>Run ID</label>
        <input
          value={runId}
          onChange={(e) => setRunId(e.target.value)}
          placeholder="e.g. 123"
          style={{ padding: 8, flex: 1, border: "1px solid #ccc", borderRadius: 6 }}
        />
        <label style={{ minWidth: 48 }}>Date</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ padding: 8, border: "1px solid #ccc", borderRadius: 6 }}
        />
        <button
          onClick={() => loadSheet(runId, date)}
          disabled={loading}
          style={{ padding: "8px 12px", borderRadius: 6, cursor: loading ? "not-allowed" : "pointer" }}
        >
          {loading ? "Loading…" : "Load"}
        </button>
      </div>

      {err ? (
        <div style={{ padding: 10, border: "1px solid #f3b0b0", background: "#fff5f5", borderRadius: 6, marginBottom: 12 }}>
          {err}
        </div>
      ) : null}

      {data ? (
        <>
          <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 8, marginBottom: 12 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8 }}>
              <div><b>Run</b><div>{fmt(header.run_id ?? header.id ?? runId)}</div></div>
              <div><b>Date</b><div>{fmt(header.local_date ?? header.date ?? data?.local_date ?? date)}</div></div>
              <div><b>Airport</b><div>{fmt(header.airport ?? data?.airport)}</div></div>
              <div><b>Truck</b><div>{fmt(header.truck ?? header.truck_code ?? header.vehicle)}</div></div>
              <div><b>Shift</b><div>{fmt(header.shift ?? header.shift_code ?? data?.shift_requested)}</div></div>
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 16, flexWrap: "wrap" }}>
              {"count_items" in counts ? <div><b>Items:</b> {fmt(counts.count_items)}</div> : null}
              {"count_flights" in counts ? <div><b>Flights:</b> {fmt(counts.count_flights)}</div> : null}
              {"count_cancelled" in counts ? <div><b>Cancelled:</b> {fmt(counts.count_cancelled)}</div> : null}
            </div>
          </div>

          <div style={{ overflowX: "auto", border: "1px solid #ddd", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["Flight", "Bay", "Fuel", "Time", "Notes"].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #ddd", background: "#fafafa" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {items.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ padding: 12 }}>No items returned.</td>
                  </tr>
                ) : (
                  items.map((it, idx) => {
                    const flight = it.flight ?? it.ident ?? it.flight_no ?? it.callsign ?? "";
                    const bay = it.bay ?? it.stand ?? it.gate ?? "";
                    const fuel = it.fuel ?? it.fuel_litres ?? it.qty ?? it.uplift ?? "";
                    const time = it.time ?? it.scheduled_time ?? it.scheduled_off ?? it.scheduled_on ?? it.etd ?? it.eta ?? "";
                    const notes = it.notes ?? it.note ?? it.comment ?? "";
                    return (
                      <tr key={it.item_id ?? it.id ?? idx}>
                        <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{fmt(flight)}</td>
                        <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{fmt(bay)}</td>
                        <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{fmt(fuel)}</td>
                        <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{fmtTime(time)}</td>
                        <td style={{ padding: 10, borderBottom: "1px solid #eee" }}>{fmt(notes)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
