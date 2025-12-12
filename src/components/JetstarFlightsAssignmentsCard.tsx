// src/components/JetstarFlightsAssignmentsCard.tsx
// EWOT: This component fetches flights + employee assignments for a given date,
// filters to Jetstar (JQ) flights only, and renders a small summary + table.

import React, { useEffect, useState } from "react";

import { API_BASE } from "../api/apiBase";

type Flight = {
  id: number;
  flight_number: string;
  destination: string;
  origin: string;
  operator_code: string | null;
  time_local: string | null;
  etd_local?: string | null;
  assigned_employee_id?: number | null;
  assigned_employee_name?: string | null;
};

type Assignment = {
  flight_id: number;
  flight_number: string;
  dest: string;
  dep_time: string;
  staff_name: string | null;
  staff_code: string | null;
};

type Props = {
  /** ISO date string e.g. "2025-12-08" */
  dateIso: string;
};

export const JetstarFlightsAssignmentsCard: React.FC<Props> = ({ dateIso }) => {
  const [flights, setFlights] = useState<Flight[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // --- helpers --------------------------------------------------------------

  async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Request failed ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  async function fetchFlightsForDate(date: string): Promise<Flight[]> {
    const url = `${API_BASE}/flights?date=${encodeURIComponent(date)}`;
    const json = await fetchJson<{ flights: Flight[] }>(url);
    return json.flights ?? [];
  }

  async function fetchEmployeeAssignmentsForDate(
    date: string,
  ): Promise<Assignment[]> {
    const url = `${API_BASE}/employee_assignments/daily?date=${encodeURIComponent(
      date,
    )}`;
    const json = await fetchJson<{ assignments: Assignment[] }>(url);
    return json.assignments ?? [];
  }

  function mergeFlightsWithAssignments(
    flights: Flight[],
    assignments: Assignment[],
  ): Flight[] {
    const byFlightId = new Map<number, Assignment[]>();
    for (const a of assignments) {
      if (!byFlightId.has(a.flight_id)) byFlightId.set(a.flight_id, []);
      byFlightId.get(a.flight_id)!.push(a);
    }

    return flights.map((f) => {
      const aList = byFlightId.get(f.id) ?? [];
      // naive: if multiple staff, just show first
      const first = aList[0];
      return {
        ...f,
        assigned_employee_name: first?.staff_name ?? null,
        assigned_employee_id: first?.staff_code
          ? Number.NaN // unknown id, but we don’t need it in the UI
          : null,
      };
    });
  }

  // --- data load: JQ-only ---------------------------------------------------

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [flightsRaw, assignments] = await Promise.all([
          fetchFlightsForDate(dateIso),
          fetchEmployeeAssignmentsForDate(dateIso),
        ]);

        // 🔸 Only keep Jetstar flights (JQ) – ignore ZL and others
        const jetstarFlights = flightsRaw.filter((f) => {
          const code = (f.operator_code || "").toUpperCase();
          return code === "JQ";
        });

        const merged = mergeFlightsWithAssignments(
          jetstarFlights,
          assignments,
        );

        if (!cancelled) {
          setFlights(merged);
        }
      } catch (err: any) {
        console.error("Failed to load Jetstar flights/assignments", err);
        if (!cancelled) {
          setError(err.message || "Failed to load flights");
          setFlights([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [dateIso]);

  // --- derived stats --------------------------------------------------------

  const totalJq = flights.length;
  const unassignedJq = flights.filter(
    (f) => !f.assigned_employee_name,
  ).length;

  // --- render ---------------------------------------------------------------

  return (
    <div className="card" style={{ marginTop: "1rem" }}>
      <div className="card-body">
        <h3 style={{ marginTop: 0 }}>
          Jetstar (JQ) flights &amp; staff assignments for {dateIso}
        </h3>

        {loading && <p>Loading Jetstar flights…</p>}
        {error && (
          <p style={{ color: "darkred" }}>
            Error loading Jetstar flights: {error}
          </p>
        )}

        {!loading && !error && (
          <>
            <p style={{ marginBottom: "0.5rem" }}>
              <strong>By airline:</strong> JQ {totalJq} flights · Unassigned:{" "}
              {unassignedJq}
            </p>

            {flights.length === 0 ? (
              <p>No Jetstar flights found for this date.</p>
            ) : (
              <table className="table table-sm">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Flight</th>
                    <th>From</th>
                    <th>To</th>
                    <th>Staff</th>
                  </tr>
                </thead>
                <tbody>
                  {flights.map((f) => (
                    <tr key={f.id}>
                      <td>{f.time_local || f.etd_local || ""}</td>
                      <td>{f.flight_number}</td>
                      <td>{f.origin}</td>
                      <td>{f.destination}</td>
                      <td>{f.assigned_employee_name || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
};
