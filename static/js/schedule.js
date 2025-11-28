// schedule.js
// Drives the /schedule page: loads flights from CodeCrafter2 and renders a table.

(function () {
  const root = document.getElementById("schedule-root");
  if (!root) return;

  const apiBase = root.getAttribute("data-api-base") || "";
  const dateInput = document.getElementById("schedule-date");
  const operatorSelect = document.getElementById("operator-filter");
  const refreshButton = document.getElementById("refresh-schedule");
  const statusDiv = document.getElementById("schedule-status");
  const summaryDiv = document.getElementById("daily-flight-summary");
  const tableBody = document.querySelector("#schedule-table tbody");

  function extractAirlineCode(flightNumber) {
    const match = (flightNumber || "").match(/^[A-Za-z]+/);
    return match ? match[0].toUpperCase() : "Unknown";
  }

  function parseTimeToMinutes(timeStr) {
    if (!timeStr) return null;
    const parts = timeStr.split(":");
    const hours = parseInt(parts[0], 10);
    const minutes = parseInt(parts[1] || "0", 10);

    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    return hours * 60 + minutes;
  }

  function getTimeBand(timeStr) {
    const minutes = parseTimeToMinutes(timeStr);
    if (minutes === null) return null;

    const amStart = 5 * 60; // 05:00
    const amEnd = 12 * 60; // 12:00 inclusive
    const pmStart = 12 * 60 + 1; // 12:01
    const pmEnd = 23 * 60; // 23:00

    if (minutes >= amStart && minutes <= amEnd) return "am";
    if (minutes >= pmStart && minutes <= pmEnd) return "pm";
    return null;
  }

  function buildSummary(flights) {
    const summary = {
      total: flights.length,
      am: { total: 0, byAirline: {} },
      pm: { total: 0, byAirline: {} },
    };

    for (const flight of flights) {
      const band = getTimeBand(flight.time_local);
      if (!band) continue;

      const airline = extractAirlineCode(flight.flight_number);
      const bucket = summary[band];
      bucket.total += 1;
      bucket.byAirline[airline] = (bucket.byAirline[airline] || 0) + 1;
    }

    return summary;
  }

  function renderAirlineBreakdown(byAirline) {
    const entries = Object.entries(byAirline).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
      return `<div class="summary-empty">No flights in this band.</div>`;
    }

    return `
      <ul class="summary-airlines">
        ${entries
          .map(
            ([code, count]) =>
              `<li><span class="summary-airline-code">${code}</span><span class="summary-airline-count">${count}</span></li>`
          )
          .join("")}
      </ul>
    `;
  }

  function renderSummary(flights) {
    if (!summaryDiv) return;

    if (!flights || flights.length === 0) {
      summaryDiv.innerHTML = `
        <h2>Daily Flight Summary</h2>
        <p class="summary-empty">No flights for this date.</p>
      `;
      return;
    }

    const summary = buildSummary(flights);

    summaryDiv.innerHTML = `
      <h2>Daily Flight Summary</h2>
      <div class="summary-total">Total flights: <strong>${summary.total}</strong></div>
      <div class="summary-grid">
        <div class="summary-band">
          <div class="summary-band-header">AM (05:00–12:00)</div>
          <div class="summary-band-total">${summary.am.total} flights</div>
          ${renderAirlineBreakdown(summary.am.byAirline)}
        </div>
        <div class="summary-band">
          <div class="summary-band-header">PM (12:01–23:00)</div>
          <div class="summary-band-total">${summary.pm.total} flights</div>
          ${renderAirlineBreakdown(summary.pm.byAirline)}
        </div>
      </div>
    `;
  }

  function clearSummary() {
    if (!summaryDiv) return;
    summaryDiv.innerHTML = `
      <h2>Daily Flight Summary</h2>
      <p class="summary-empty">Loading…</p>
    `;
  }

  function formatDateForApi(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function setDefaultDate() {
    const today = new Date();
    dateInput.value = formatDateForApi(today);
  }

  async function loadSchedule() {
    const dateVal = dateInput.value;
    if (!dateVal) {
      statusDiv.textContent = "Please select a date.";
      return;
    }

    statusDiv.textContent = "Loading…";
    clearSummary();

    try {
      const url = `${apiBase}/api/flights?date=${encodeURIComponent(dateVal)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "Unknown error");
      }

      renderRows(data.flights || []);
    } catch (err) {
      console.error("Failed to load schedule", err);
      statusDiv.textContent = "Error loading schedule. Check connection or try again.";
      tableBody.innerHTML = "";
      renderSummary([]);
    }
  }

  function sortFlightsByTime(flights) {
    return [...flights].sort((a, b) => {
      const timeA = (a.time_local || "").padStart(5, "0");
      const timeB = (b.time_local || "").padStart(5, "0");
      return timeA.localeCompare(timeB);
    });
  }

  function renderRows(flights) {
    const operatorFilter = (operatorSelect.value || "").toUpperCase();
    tableBody.innerHTML = "";

    const filtered = sortFlightsByTime(flights).filter((f) => {
      if (!operatorFilter) return true;
      return (f.operator_code || "").toUpperCase() === operatorFilter;
    });

    if (filtered.length === 0) {
      statusDiv.textContent = "No flights found for this date / operator.";
      renderSummary([]);
      return;
    }

    statusDiv.textContent = `Showing ${filtered.length} flights.`;
    renderSummary(filtered);

    for (const f of filtered) {
      const tr = document.createElement("tr");

      const tdTime = document.createElement("td");
      tdTime.textContent = f.time_local || "";
      tr.appendChild(tdTime);

      const tdFlight = document.createElement("td");
      tdFlight.textContent = f.flight_number || "";
      tr.appendChild(tdFlight);

      const tdDest = document.createElement("td");
      tdDest.textContent = f.destination || "";
      tr.appendChild(tdDest);

      const tdOperator = document.createElement("td");
      tdOperator.textContent = f.operator_code || "";
      tr.appendChild(tdOperator);

      const tdNotes = document.createElement("td");
      tdNotes.textContent = f.notes || "";
      tr.appendChild(tdNotes);

      tableBody.appendChild(tr);
    }
  }

  refreshButton.addEventListener("click", loadSchedule);
  dateInput.addEventListener("change", loadSchedule);
  operatorSelect.addEventListener("change", loadSchedule);

  setDefaultDate();
  loadSchedule();
})();
