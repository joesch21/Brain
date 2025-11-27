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
  const tableBody = document.querySelector("#schedule-table tbody");

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
      return;
    }

    statusDiv.textContent = `Showing ${filtered.length} flights.`;

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
