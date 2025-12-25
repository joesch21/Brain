// schedule.js
// Drives the /schedule page: loads flights from CodeCrafter2 and renders a table.

(function () {
  const root = document.getElementById("schedule-root");
  if (!root) return;

  const apiBaseRaw = root.getAttribute("data-api-base") || "";
  const apiBase = apiBaseRaw.replace(/\/$/, "");
  const dateInput = document.getElementById("schedule-date");
  const operatorSelect = document.getElementById("operator-filter");
  const refreshButton = document.getElementById("refresh-schedule");
  const statusDiv = document.getElementById("schedule-status");
  const testApiButton = document.getElementById("schedule-test-api");
  const diagnosticsDiv = document.getElementById("schedule-api-diagnostics");
  const summaryDiv = document.getElementById("daily-flight-summary");
  const tableBody = document.querySelector("#schedule-table tbody");
  const DEFAULT_AIRPORT = "YSSY";

  function setStatus(message, isError = false) {
    statusDiv.textContent = message || "";
    statusDiv.classList.toggle("is-error", Boolean(isError));
  }

  function setDiagnostics(message, isError = false) {
    if (!diagnosticsDiv) return;
    diagnosticsDiv.textContent = message || "";
    diagnosticsDiv.classList.toggle("is-error", Boolean(isError));
    diagnosticsDiv.classList.toggle("is-hidden", !message);
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

  // CWO-13B: one-click diagnostics for this date from the Schedule page.
  async function runDiagnostics() {
    if (!testApiButton) return;

    const dateVal = dateInput.value;
    if (!dateVal) {
      setDiagnostics("Please select a date to test.", true);
      return;
    }

    setDiagnostics("Running diagnostics…", false);
    testApiButton.disabled = true;

    const airline = (operatorSelect.value || "ALL").toUpperCase() || "ALL";
    const qs = `?date=${encodeURIComponent(dateVal)}&airport=${encodeURIComponent(DEFAULT_AIRPORT)}&airline=${encodeURIComponent(airline)}`;

    try {
      const [statusRes, flightsRes, runsRes] = await Promise.all([
        fetchApiStatus(`${apiBase}/api/status${qs}`),
        fetchApiStatus(`${apiBase}/api/flights${qs}`),
        fetchApiStatus(`${apiBase}/api/runs${qs}`),
      ]);

      const flightsCount = Array.isArray(flightsRes.data)
        ? flightsRes.data.length
        : 0;
      const runsCount = Array.isArray(runsRes.data)
        ? runsRes.data.length
        : 0;

      const statusData = statusRes.data || {};
      const backendOk =
        (statusData &&
          (statusData.ok === true ||
            statusData.backend_ok === true ||
            (statusData.backend && statusData.backend.ok === true))) ||
        false;
      const dbOk =
        (statusData &&
          (statusData.db_ok === true ||
            statusData.database_ok === true ||
            (statusData.database && statusData.database.ok === true))) ||
        false;

      const parts = [];

      if (statusRes.ok) {
        parts.push(
          `Status: OK (backend ${backendOk ? "OK" : "ISSUE"}, DB ${
            dbOk ? "OK" : "ISSUE"
          })`
        );
      } else {
        parts.push(
          `Status: ERROR (${statusRes.status || "?"}) – ${
            statusRes.error || "Unknown"
          }`
        );
      }

      if (flightsRes.ok) {
        parts.push(`Flights: ${flightsCount}`);
      } else {
        parts.push(
          `Flights: ERROR (${flightsRes.status || "?"}) – ${
            flightsRes.error || "Unknown"
          }`
        );
      }

      if (runsRes.ok) {
        parts.push(`Runs: ${runsCount}`);
      } else {
        parts.push(
          `Runs: ERROR (${runsRes.status || "?"}) – ${
            runsRes.error || "Unknown"
          }`
        );
      }

      const summary = parts.join(" · ");

      const detailObj = {
        date: dateVal,
        status: {
          ok: statusRes.ok,
          httpStatus: statusRes.status,
          error: statusRes.error,
        },
        flights: {
          ok: flightsRes.ok,
          httpStatus: flightsRes.status,
          error: flightsRes.error,
          count: flightsCount,
        },
        runs: {
          ok: runsRes.ok,
          httpStatus: runsRes.status,
          error: runsRes.error,
          count: runsCount,
        },
      };

      const detailJson = JSON.stringify(detailObj, null, 2);
      const allOk = statusRes.ok && flightsRes.ok && runsRes.ok;

      setDiagnostics(`${summary}\n${detailJson}`, !allOk);
    } catch (err) {
      setDiagnostics(
        `Diagnostics failed: ${err?.message || String(err)}`,
        true
      );
    } finally {
      testApiButton.disabled = false;
    }
  }

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
      setStatus("Please select a date.");
      return;
    }

    setStatus("Loading…");
    clearSummary();

    try {
      const airline = (operatorSelect.value || "ALL").toUpperCase() || "ALL";
      const url = `${apiBase}/api/flights?date=${encodeURIComponent(dateVal)}&airport=${encodeURIComponent(DEFAULT_AIRPORT)}&airline=${encodeURIComponent(airline)}`;
      const res = await fetchApiStatus(url);
      if (!res.ok) {
        throw new Error(formatApiError("Flights", res));
      }

      const data = res.data || {};
      if (data.ok === false) {
        throw new Error(formatApiError("Flights", { status: 500, error: data.error }));
      }

      const flights = data.flights || [];
      renderRows(flights);
      if (flights.length === 0) {
        setStatus("No flights for this date.");
      }
    } catch (err) {
      console.error("Failed to load schedule", err);
      setStatus(
        `Error loading schedule (${err.message || "Unknown error"}).`,
        true
      );
      tableBody.innerHTML =
        '<tr><td colspan="5" class="schedule-empty">No flights for this date.</td></tr>';
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
      setStatus("No flights for this date.");
      tableBody.innerHTML =
        '<tr><td colspan="5" class="schedule-empty">No flights for this date.</td></tr>';
      renderSummary([]);
      return;
    }

    setStatus(`Showing ${filtered.length} flights.`);
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

  if (testApiButton) {
    testApiButton.addEventListener("click", runDiagnostics);
  }

  setDefaultDate();
  loadSchedule();
})();
