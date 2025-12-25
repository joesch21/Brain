// planner.js
// Drives the /planner page: combines flights, runs, summary, and run sheet preview.

(function () {
  const root = document.getElementById("planner-root");
  if (!root) return;

  const dateInput = document.getElementById("plannerDate");
  const airlineSelect = document.getElementById("plannerAirline");
  const shiftSelect = document.getElementById("plannerShift");
  const statusDiv = document.getElementById("plannerStatus");
  const summaryDiv = document.getElementById("planner-summary");

  const flightsBody = document.getElementById("planner-flights-body");
  const runsGrid = document.getElementById("planner-runs-grid");
  const runSheet = document.getElementById("planner-run-sheet");

  const autoAssignButton = document.getElementById("planner-auto-assign");
  const printButton = document.getElementById("planner-print");

  const DEFAULT_AIRPORT = "YSSY";

  let flights = [];
  let runs = [];
  let selectedRunId = null;
  let selectedFlightId = null;

  function formatDateForApi(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function parseTimeToMinutes(timeStr) {
    if (!timeStr) return null;
    const [h, m = "0"] = timeStr.split(":");
    const hours = parseInt(h, 10);
    const minutes = parseInt(m, 10);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return hours * 60 + minutes;
  }

  function getTimeBand(timeStr) {
    const mins = parseTimeToMinutes(timeStr);
    if (mins === null) return null;
    if (mins >= 5 * 60 && mins <= 12 * 60) return "am"; // 05:00-12:00
    if (mins >= 12 * 60 + 1 && mins <= 23 * 60) return "pm"; // 12:01-23:00
    return null;
  }

  function extractAirlineCode(flightNumber) {
    const match = (flightNumber || "").match(/^[A-Za-z]+/);
    return match ? match[0].toUpperCase() : "";
  }

  function setDefaultDate() {
    const today = new Date();
    dateInput.value = formatDateForApi(today);
  }

  function setStatus(message, isError = false) {
    statusDiv.textContent = message || "";
    statusDiv.classList.toggle("is-error", Boolean(isError));
  }

  async function fetchApiStatus(url, options = {}) {
    try {
      const res = await fetch(url, options);
      const status = res.status;
      const contentType = res.headers?.get("content-type") || "";
      let body;

      try {
        if (contentType.includes("application/json")) {
          body = await res.json();
        } else {
          body = await res.text();
        }
      } catch (err) {
        body = undefined;
      }

      if (res.ok) {
        return { ok: true, status, data: body };
      }

      const error = (() => {
        if (body && typeof body === "object" && body.error) return body.error;
        if (typeof body === "string" && body.trim()) return body.trim();
        if (status >= 500) return "upstream scheduling backend unavailable";
        return "Request failed";
      })();

      return { ok: false, status, error };
    } catch (err) {
      return { ok: false, status: 0, error: err?.message || "Network error" };
    }
  }

  function formatApiError(label, result) {
    const statusLabel = result.status === 0 ? "network" : result.status;
    return `${label} ${statusLabel} – ${result.error || "Unknown error"}`;
  }

  function buildFlightAssignmentMap() {
    const map = new Map();
    (runs || []).forEach((run) => {
      (run.flights || []).forEach((flight) => {
        if (flight && flight.id !== undefined && flight.id !== null) {
          map.set(flight.id, run);
        }
      });
    });
    return map;
  }

  async function loadFlights() {
    const dateVal = dateInput.value;
    if (!dateVal) return [];

    const airline = (airlineSelect.value || "ALL").toUpperCase() || "ALL";
    const url = `/api/flights?date=${encodeURIComponent(dateVal)}&airport=${encodeURIComponent(DEFAULT_AIRPORT)}&airline=${encodeURIComponent(airline)}`;
    const res = await fetchApiStatus(url);
    if (!res.ok) {
      return {
        ok: false,
        flights: [],
        message: formatApiError("Flights", res),
      };
    }

    const data = res.data || {};
    if (data && data.ok === false) {
      return {
        ok: false,
        flights: [],
        message: formatApiError("Flights", { status: res.status, error: data.error }),
      };
    }

    return { ok: true, flights: data.flights || data || [] };
  }

  async function loadRuns() {
    const dateVal = dateInput.value;
    if (!dateVal) return [];

    const airline = (airlineSelect.value || "ALL").toUpperCase() || "ALL";
    const url = `/api/runs?date=${encodeURIComponent(dateVal)}&airport=${encodeURIComponent(DEFAULT_AIRPORT)}&airline=${encodeURIComponent(airline)}`;
    const res = await fetchApiStatus(url);
    if (!res.ok) {
      return {
        ok: false,
        runs: [],
        message: formatApiError("Runs", res),
      };
    }

    const data = res.data || {};
    if (data && data.ok === false) {
      return {
        ok: false,
        runs: [],
        message: formatApiError("Runs", { status: res.status, error: data.error }),
      };
    }

    return { ok: true, runs: data.runs || data || [] };
  }

  async function refreshData() {
    const dateVal = dateInput.value;
    if (!dateVal) {
      setStatus("Please select a date.");
      return;
    }

    setStatus("Loading planner…");
    flightsBody.innerHTML = "";
    runsGrid.innerHTML = "";
    runSheet.innerHTML = "";

    try {
      const [flightResult, runResult] = await Promise.all([
        loadFlights(),
        loadRuns(),
      ]);

      flights = flightResult.flights || [];
      runs = runResult.runs || [];

      const errors = [];
      if (!flightResult.ok) errors.push(flightResult.message);
      if (!runResult.ok) errors.push(runResult.message);

      if (errors.length) {
        setStatus(`Error loading planner data: ${errors.join("; ")}`, true);
      } else {
        setStatus(`Loaded ${flights.length} flights and ${runs.length} runs.`);
      }
      renderAll();
    } catch (err) {
      console.error("Failed to load planner data", err);
      setStatus(
        `Error loading planner data: ${err.message || err}`,
        true
      );
      flights = [];
      runs = [];
      renderAll();
    }
  }

  function filterFlights() {
    const airlineFilter = (airlineSelect.value || "").toUpperCase();
    const shiftFilter = (shiftSelect.value || "").toLowerCase();

    return (flights || []).filter((flight) => {
      const airline = extractAirlineCode(flight.flight_number);
      if (airlineFilter && airline !== airlineFilter) return false;

      const band = getTimeBand(flight.time_local);
      if (shiftFilter && band !== shiftFilter) return false;

      return true;
    });
  }

  function renderFlightsTable() {
    const filteredFlights = filterFlights();
    const assignmentMap = buildFlightAssignmentMap();

    if (!filteredFlights.length) {
      flightsBody.innerHTML = `<tr><td colspan="5" class="planner-empty">No flights for this date.</td></tr>`;
      return;
    }

    flightsBody.innerHTML = "";

    filteredFlights
      .slice()
      .sort((a, b) => (a.time_local || "").localeCompare(b.time_local || ""))
      .forEach((flight) => {
        const row = document.createElement("tr");
        row.className = "planner-flight-row";
        row.dataset.flightId = flight.id;

        if (selectedFlightId === flight.id) {
          row.classList.add("is-selected");
        }

        const run = assignmentMap.get(flight.id);
        const assignedLabel = run
          ? `${run.operator_code || ""} • ${run.label || ""}`.trim()
          : "Unassigned";

        row.innerHTML = `
          <td>${flight.time_local || ""}</td>
          <td>${flight.flight_number || ""}</td>
          <td>${flight.destination || flight.dest || ""}</td>
          <td>${extractAirlineCode(flight.flight_number)}</td>
          <td><span class="planner-pill ${run ? "is-assigned" : "is-unassigned"}">${assignedLabel || "Unassigned"}</span></td>
        `;

        row.addEventListener("click", () => {
          selectedFlightId = flight.id;
          if (run) {
            selectedRunId = run.id;
            scrollRunIntoView(run.id);
          }
          renderAll();
        });

        flightsBody.appendChild(row);
      });
  }

  function getShiftBucket(run) {
    const start = run.start_time || (run.flights && run.flights[0] && run.flights[0].time_local);
    const mins = parseTimeToMinutes(start);
    if (mins === null) return "unscheduled";
    if (mins >= 5 * 60 && mins < 12 * 60) return "am";
    if (mins >= 12 * 60 && mins < 17 * 60) return "midday";
    if (mins >= 17 * 60 && mins <= 23 * 60) return "evening";
    return "unscheduled";
  }

  function renderRunsGrid() {
    const shiftLabels = {
      am: "AM (05:00–12:00)",
      midday: "Midday (12:00–17:00)",
      evening: "Evening (17:00–23:00)",
      unscheduled: "Unscheduled",
    };

    const groups = { am: [], midday: [], evening: [], unscheduled: [] };
    runs.forEach((run) => {
      const bucket = getShiftBucket(run);
      groups[bucket] = groups[bucket] || [];
      groups[bucket].push(run);
    });

    runsGrid.innerHTML = "";

    Object.entries(groups).forEach(([key, list]) => {
      const section = document.createElement("div");
      section.className = "planner-run-group";
      section.innerHTML = `<div class="planner-run-group__title">${shiftLabels[key] || key}</div>`;

      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "planner-empty";
        empty.textContent = "No runs in this window.";
        section.appendChild(empty);
      } else {
        list
          .slice()
          .sort((a, b) => (a.start_time || "").localeCompare(b.start_time || ""))
          .forEach((run) => {
            const card = document.createElement("div");
            card.className = "planner-run-card cc-card";
            card.dataset.runId = run.id;

            if (selectedRunId === run.id) {
              card.classList.add("is-selected");
            }

            const header = document.createElement("div");
            header.className = "planner-run-card__header";
            header.innerHTML = `
              <div class="planner-run-title">${run.operator_code || ""} • ${run.label || "Run"}</div>
              <div class="planner-run-meta">${run.start_time || ""}–${run.end_time || ""} • Truck ${run.truck_id || "Unassigned"}</div>
            `;
            card.appendChild(header);

            const flightsTable = document.createElement("table");
            flightsTable.className = "planner-run-card__table";
            flightsTable.innerHTML = `
              <thead><tr><th>Time</th><th>Flight</th><th>Dest</th></tr></thead>
              <tbody></tbody>
            `;
            const tbody = flightsTable.querySelector("tbody");

            const sortedFlights = (run.flights || [])
              .slice()
              .sort((a, b) => (a.sequence_index || 0) - (b.sequence_index || 0) || (a.time_local || "").localeCompare(b.time_local || ""));

            if (!sortedFlights.length) {
              const row = document.createElement("tr");
              row.innerHTML = `<td colspan="3" class="planner-muted">No flights assigned.</td>`;
              tbody.appendChild(row);
            } else {
              sortedFlights.forEach((f) => {
                const row = document.createElement("tr");
                row.innerHTML = `
                  <td>${f.time_local || ""}</td>
                  <td>${f.flight_number || ""}</td>
                  <td>${f.destination || f.dest || ""}</td>
                `;
                tbody.appendChild(row);
              });
            }

            flightsTable.appendChild(tbody);
            card.appendChild(flightsTable);

            card.addEventListener("click", () => {
              selectedRunId = run.id;
              selectedFlightId = null;
              renderAll();
            });

            section.appendChild(card);
          });
      }

      runsGrid.appendChild(section);
    });

    // Static info boxes for placeholders
    const infoBox = document.createElement("div");
    infoBox.className = "planner-info cc-card";
    infoBox.innerHTML = `<div class="planner-info__title">Ampol to pick up</div><p class="planner-muted">Add pickup instructions here once backend flags exist.</p>`;
    runsGrid.appendChild(infoBox);
  }

  function renderRunSheet() {
    const run = runs.find((r) => r.id === selectedRunId) || runs[0];

    if (!run) {
      runSheet.innerHTML = `<p class="planner-empty">Select a run to see its run sheet.</p>`;
      return;
    }

    selectedRunId = run.id;

    const dateVal = dateInput.value;
    const rows = (run.flights || [])
      .slice()
      .sort((a, b) => (a.sequence_index || 0) - (b.sequence_index || 0) || (a.time_local || "").localeCompare(b.time_local || ""));

    const rowsHtml = rows
      .map(
        (f) => `
          <tr>
            <td>${f.flight_number || ""}</td>
            <td>${f.destination || f.dest || ""}</td>
            <td>${f.time_local || ""}</td>
            <td>${f.bay || ""}</td>
            <td>${f.tail_number || f.rego || ""}</td>
            <td><input type="checkbox" disabled ${f.on_time ? "checked" : ""} /></td>
            <td><input type="text" disabled value="${f.status || "Planned"}" /></td>
            <td><input type="text" disabled value="${f.start_figure || ""}" /></td>
            <td><input type="text" disabled value="${f.uplift || ""}" /></td>
          </tr>
        `
      )
      .join("");

    runSheet.innerHTML = `
      <div class="planner-run-sheet__header">
        <div>
          <div class="planner-pill is-assigned">${run.operator_code || ""}</div>
          <div class="planner-run-sheet__title">${run.label || "Run"} • ${dateVal}</div>
          <div class="planner-muted">Truck ${run.truck_id || "Unassigned"}</div>
        </div>
        <div class="planner-run-sheet__meta">${run.start_time || ""}–${run.end_time || ""}</div>
      </div>
      <div class="planner-run-sheet__table">
        <table>
          <thead>
            <tr>
              <th>FLIGHT</th>
              <th>DEST</th>
              <th>TIME</th>
              <th>BAY</th>
              <th>REGO</th>
              <th>ON TIME</th>
              <th>STATUS</th>
              <th>START FIG</th>
              <th>UPLIFT</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="9" class="planner-empty">No flights on this run.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }

  function buildSummary() {
    const assignmentMap = buildFlightAssignmentMap();
    const filteredFlights = filterFlights();

    const summary = {
      total: filteredFlights.length,
      am: { total: 0, byAirline: {} },
      pm: { total: 0, byAirline: {} },
      unassigned: 0,
      notRunning: 0,
    };

    filteredFlights.forEach((flight) => {
      const band = getTimeBand(flight.time_local);
      const airline = extractAirlineCode(flight.flight_number);
      if (band && summary[band]) {
        summary[band].total += 1;
        summary[band].byAirline[airline] = (summary[band].byAirline[airline] || 0) + 1;
      }

      if (!assignmentMap.has(flight.id)) {
        summary.unassigned += 1;
      }
    });

    return summary;
  }

  function renderSummary() {
    const summary = buildSummary();

    function renderBreakdown(byAirline) {
      const entries = Object.entries(byAirline).sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length) return `<div class="planner-muted">No flights.</div>`;
      return `<ul class="planner-airlines">${entries
        .map(([code, count]) => `<li><span class="code">${code}</span><span class="count">${count}</span></li>`)
        .join("")}</ul>`;
    }

    summaryDiv.innerHTML = `
      <div class="planner-summary__row">
        <div class="planner-summary__stat">
          <div class="label">Total</div>
          <div class="value">${summary.total}</div>
        </div>
        <div class="planner-summary__stat">
          <div class="label">AM (05:00–12:00)</div>
          <div class="value">${summary.am.total}</div>
          ${renderBreakdown(summary.am.byAirline)}
        </div>
        <div class="planner-summary__stat">
          <div class="label">PM (12:01–23:00)</div>
          <div class="value">${summary.pm.total}</div>
          ${renderBreakdown(summary.pm.byAirline)}
        </div>
        <div class="planner-summary__stat">
          <div class="label">Unassigned</div>
          <div class="value">${summary.unassigned}</div>
        </div>
        <div class="planner-summary__stat">
          <div class="label">Not running</div>
          <div class="value">${summary.notRunning}</div>
        </div>
      </div>
    `;
  }

  function scrollRunIntoView(runId) {
    const card = runsGrid.querySelector(`[data-run-id="${runId}"]`);
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function renderAll() {
    renderFlightsTable();
    renderRunsGrid();
    renderRunSheet();
    renderSummary();
  }

  async function handleAutoAssign() {
    const dateVal = dateInput.value;
    if (!dateVal) {
      setStatus("Please select a date before auto-assigning.", true);
      return;
    }

    autoAssignButton.disabled = true;
    autoAssignButton.textContent = "Assigning…";
    setStatus("Auto-assigning runs…");
    try {
      const res = await fetch(`/api/runs/auto_assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateVal, airline: "ALL" }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      const summary = data.summary || {};
      const assignedRunsCount = Number.isFinite(summary.assigned_runs)
        ? summary.assigned_runs
        : Array.isArray(data.assigned_runs)
          ? data.assigned_runs.length
          : 0;
      const assignedFlightsCount = Number.isFinite(summary.assigned_flights)
        ? summary.assigned_flights
        : 0;
      const unassignedCount = Number.isFinite(summary.unassigned)
        ? summary.unassigned
        : Array.isArray(data.unassigned_runs)
          ? data.unassigned_runs.length
          : (data.unassigned_flight_ids || []).length;
      const modeSuffix = data.auto_assign_mode
        ? ` Mode: ${data.auto_assign_mode}.`
        : "";

      if (
        Number.isFinite(assignedRunsCount) ||
        Number.isFinite(assignedFlightsCount) ||
        Number.isFinite(unassignedCount)
      ) {
        setStatus(
          `Auto-assign complete – runs: ${assignedRunsCount}, flights: ${assignedFlightsCount}, unassigned: ${unassignedCount}.${modeSuffix} Reloading planner…`
        );
      } else {
        setStatus("Auto-assign completed. Reloading planner…");
      }

      await refreshData();
    } catch (err) {
      console.error("Auto-assign failed", err);
      setStatus(
        `Auto-assign failed: ${err?.message || "Unknown error"}.`,
        true
      );
    } finally {
      autoAssignButton.disabled = false;
      autoAssignButton.textContent = "Auto-assign runs";
    }
  }

  function handlePrint() {
    console.log("Print run sheets – coming soon");
    alert("Print run sheets stub – will be implemented in a later CWO.");
  }

  dateInput.addEventListener("change", refreshData);
  airlineSelect.addEventListener("change", renderAll);
  shiftSelect.addEventListener("change", renderAll);
  autoAssignButton.addEventListener("click", handleAutoAssign);
  printButton.addEventListener("click", handlePrint);

  setDefaultDate();
  refreshData();
})();
