// Runs overview page script
// Fetches runs from CodeCrafter2 and renders PT-style run cards + run sheet table.
(function () {
  const root = document.getElementById("runs-root");
  if (!root) return;

  const apiBaseRaw = root.getAttribute("data-api-base") || "";
  const apiBase = apiBaseRaw.replace(/\/$/, "");

  const dateInput = document.getElementById("runs-date");
  const operatorSelect = document.getElementById("runs-operator-filter");
  const refreshButton = document.getElementById("runs-refresh");
  const autoAssignButton = document.getElementById("runs-auto-assign");
  const statusDiv = document.getElementById("runs-status");
  const cardsContainer = document.getElementById("runs-cards");

  const runSheetSection = document.getElementById("run-sheet-section");
  const runSheetTitle = document.getElementById("run-sheet-title");
  const runSheetTableBody = document.querySelector("#run-sheet-table tbody");

  let currentRuns = [];

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

  async function autoAssignRuns() {
    const dateVal = dateInput.value;
    if (!dateVal) {
      statusDiv.textContent = "Please select a date before auto-assigning.";
      return;
    }

    const confirmMsg = `Auto-assign runs for ${dateVal}? This will rebuild assignments according to backend rules.`;
    const ok = window.confirm(confirmMsg);
    if (!ok) {
      return;
    }

    statusDiv.textContent = "Auto-assigning runs…";

    try {
      const url = `${apiBase}/api/assignments/generate`;
      const body = {
        date: dateVal,
        respect_existing_runs: false,
      };

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      if (!data.ok) {
        throw new Error(data.error || "Unknown error from assignments API");
      }

      const assigned = data.assigned ?? 0;
      const unassigned = (data.unassigned_flight_ids || []).length;
      statusDiv.textContent = `Auto-assigned ${assigned} flights. Unassigned: ${unassigned}. Reloading runs…`;

      await loadRuns();
    } catch (err) {
      console.error("Failed to auto-assign runs", err);
      statusDiv.textContent = "Error during auto-assignment. Check backend logs.";
    }
  }

  async function loadRuns() {
    const dateVal = dateInput.value;
    if (!dateVal) {
      statusDiv.textContent = "Please select a date.";
      return;
    }

    statusDiv.textContent = "Loading runs…";
    cardsContainer.innerHTML = "";
    hideRunSheet();

    try {
      const url = `${apiBase}/api/runs?date=${encodeURIComponent(dateVal)}`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = await res.json();
      const runs = Array.isArray(data.runs) ? data.runs : [];
      currentRuns = runs;
      renderRunCards();
    } catch (err) {
      console.error("Failed to load runs", err);
      statusDiv.textContent = "Error loading runs. Check connection or try again.";
      currentRuns = [];
      cardsContainer.innerHTML = "";
    }
  }

  function renderRunCards() {
    cardsContainer.innerHTML = "";
    const operatorFilter = (operatorSelect.value || "").toUpperCase();

    const filtered = currentRuns.filter((run) => {
      if (!operatorFilter) return true;
      return (run.operator_code || "").toUpperCase() === operatorFilter;
    });

    if (filtered.length === 0) {
      statusDiv.textContent = "No runs found for this date / operator.";
      return;
    }

    statusDiv.textContent = `Showing ${filtered.length} runs.`;

    filtered.forEach((run) => {
      const card = document.createElement("div");
      card.className = "run-card";

      const header = document.createElement("div");
      header.className = "run-card-header";
      header.textContent = `${run.label || "Run"} • ${run.operator_code || "?"}`;
      card.appendChild(header);

      const meta = document.createElement("div");
      meta.className = "run-card-meta";
      const start = run.start_time || "";
      const end = run.end_time || "";
      const truck = run.truck_id || "Unassigned";
      const flightCount = (run.flights || []).length;
      meta.textContent = `Time: ${start}–${end} · Truck: ${truck} · Flights: ${flightCount}`;
      card.appendChild(meta);

      const button = document.createElement("button");
      button.className = "cc-btn cc-btn--primary run-card-btn";
      button.textContent = "View run sheet";
      button.addEventListener("click", () => {
        showRunSheet(run);
      });
      card.appendChild(button);

      cardsContainer.appendChild(card);
    });
  }

  function hideRunSheet() {
    runSheetSection.style.display = "none";
    runSheetTableBody.innerHTML = "";
    runSheetTitle.textContent = "Run sheet";
  }

  function showRunSheet(run) {
    const label = run.label || "";
    const op = run.operator_code || "";
    const truck = run.truck_id || "Unassigned";
    runSheetTitle.textContent = `Run sheet – ${label} – ${op} – Truck ${truck}`;

    runSheetTableBody.innerHTML = "";

    const flights = (run.flights || []).slice().sort((a, b) => {
      return (a.sequence_index || 0) - (b.sequence_index || 0);
    });

    flights.forEach((fr) => {
      const tr = document.createElement("tr");

      const tdSeq = document.createElement("td");
      tdSeq.textContent = fr.sequence_index ?? "";
      tr.appendChild(tdSeq);

      const tdTime = document.createElement("td");
      tdTime.textContent = fr.planned_time || (fr.flight && fr.flight.time_local) || "";
      tr.appendChild(tdTime);

      const tdFlight = document.createElement("td");
      tdFlight.textContent = fr.flight?.flight_number || "";
      tr.appendChild(tdFlight);

      const tdDest = document.createElement("td");
      tdDest.textContent = fr.flight?.destination || "";
      tr.appendChild(tdDest);

      const tdOp = document.createElement("td");
      tdOp.textContent = fr.flight?.operator_code || "";
      tr.appendChild(tdOp);

      const tdNotes = document.createElement("td");
      tdNotes.textContent = fr.flight?.notes || "";
      tr.appendChild(tdNotes);

      const tdStatus = document.createElement("td");
      tdStatus.textContent = fr.status || "planned";
      tr.appendChild(tdStatus);

      runSheetTableBody.appendChild(tr);
    });

    runSheetSection.style.display = flights.length > 0 ? "block" : "none";
  }

  refreshButton.addEventListener("click", loadRuns);
  if (autoAssignButton) {
    autoAssignButton.addEventListener("click", autoAssignRuns);
  }
  dateInput.addEventListener("change", loadRuns);
  operatorSelect.addEventListener("change", renderRunCards);

  setDefaultDate();
  loadRuns();
})();
