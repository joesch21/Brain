// runs.js
// EWOT: This script drives the /runs page: it loads runs, shows unassigned flights, and enables drag-and-drop editing.

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

  const unassignedSection = document.getElementById("unassigned-section");
  const unassignedSummary = document.getElementById("unassigned-summary");
  const unassignedTableBody = document.querySelector("#unassigned-table tbody");

  const editToggle = document.getElementById("runs-edit-toggle");
  const editGrid = document.getElementById("runs-edit-grid");

  const runSheetSection = document.getElementById("run-sheet-section");
  const runSheetTitle = document.getElementById("run-sheet-title");
  const runSheetTableBody = document.querySelector("#run-sheet-table tbody");

  let currentRuns = [];

  let draggedItem = null;
  let draggedItemType = null; // "run-item" or "unassigned"

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

  function formatDateForApi(date) {
    // EWOT: Converts a Date object to YYYY-MM-DD for the API query.
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function setDefaultDate() {
    // EWOT: Sets the date input to today's date.
    const today = new Date();
    dateInput.value = formatDateForApi(today);
  }

  async function loadRuns() {
    // EWOT: Fetches runs for the selected date and updates currentRuns and cards.
    const dateVal = dateInput.value;
    if (!dateVal) {
      setStatus("Please select a date.");
      return;
    }

    setStatus("Loading runs…");
    cardsContainer.innerHTML = "";
    hideRunSheet();

    try {
      const url = `${apiBase}/api/runs?date=${encodeURIComponent(dateVal)}`;
      const res = await fetchApiStatus(url);
      if (!res.ok) {
        throw new Error(formatApiError("Runs", res));
      }

      const data = res.data || {};
      if (!data.ok) {
        throw new Error(
          formatApiError("Runs", { status: res.status, error: data.error })
        );
      }

      currentRuns = data.runs || [];
      renderRunCards();
    } catch (err) {
      console.error("Failed to load runs", err);
      setStatus(
        `Error loading runs (${err.message || "Unknown error"}).`,
        true
      );
      currentRuns = [];
      cardsContainer.innerHTML = "";
    }
  }

  function renderRunCards() {
    // EWOT: Renders runs as PT-style cards with basic info and a 'View run sheet' button.
    cardsContainer.innerHTML = "";
    const operatorFilter = (operatorSelect.value || "").toUpperCase();

    const filtered = currentRuns.filter((run) => {
      if (!operatorFilter) return true;
      return (run.operator_code || "").toUpperCase() === operatorFilter;
    });

    if (filtered.length === 0) {
      setStatus("No runs found for this date / operator.");
      return;
    }

    setStatus(`Showing ${filtered.length} runs.`);

    filtered.forEach((run) => {
      const card = document.createElement("div");
      card.className = "run-card";

      const header = document.createElement("div");
      header.className = "run-card-header";
      header.textContent = `${run.label} – ${run.operator_code || "?"}`;
      card.appendChild(header);

      const meta = document.createElement("div");
      meta.className = "run-card-meta";
      const start = run.start_time || "";
      const end = run.end_time || "";
      const truck = run.truck_id || "Unassigned";
      const flightCount = (run.flights || []).length;
      meta.textContent = `Time: ${start}–${end} | Truck: ${truck} | Flights: ${flightCount}`;
      card.appendChild(meta);

      const button = document.createElement("button");
      button.textContent = "View run sheet";
      button.addEventListener("click", () => showRunSheet(run));
      card.appendChild(button);

      cardsContainer.appendChild(card);
    });
  }

  function hideRunSheet() {
    // EWOT: Hides the run sheet section and clears rows.
    runSheetSection.style.display = "none";
    runSheetTableBody.innerHTML = "";
    runSheetTitle.textContent = "Run sheet";
  }

  function showRunSheet(run) {
    // EWOT: Shows a selected run's flights in the run sheet table.
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

  function buildEditGrid() {
    // EWOT: Builds the drag-and-drop run columns from currentRuns.
    editGrid.innerHTML = "";
    const operatorFilter = (operatorSelect.value || "").toUpperCase();

    const filtered = currentRuns.filter((run) => {
      if (!operatorFilter) return true;
      return (run.operator_code || "").toUpperCase() === operatorFilter;
    });

    filtered.forEach((run) => {
      const col = document.createElement("div");
      col.className = "run-edit-column";
      col.setAttribute("data-run-id", run.id);

      const header = document.createElement("div");
      header.className = "run-edit-column-header";
      const start = run.start_time || "";
      const end = run.end_time || "";
      const truck = run.truck_id || "Unassigned";
      header.textContent = `${run.label} – ${run.operator_code || "?"} (${start}–${end}) Truck: ${truck}`;
      col.appendChild(header);

      const list = document.createElement("ul");
      list.className = "run-edit-list";
      col.appendChild(list);

      const flights = (run.flights || []).slice().sort((a, b) => {
        return (a.sequence_index || 0) - (b.sequence_index || 0);
      });

      flights.forEach((fr) => {
        const li = document.createElement("li");
        li.className = "run-edit-item";
        li.setAttribute("draggable", "true");
        li.setAttribute("data-flight-run-id", fr.id);
        li.setAttribute("data-run-id", run.id);

        const time = fr.planned_time || (fr.flight && fr.flight.time_local) || "";
        const fn = fr.flight?.flight_number || "";
        const dest = fr.flight?.destination || "";
        li.textContent = `${time} ${fn} → ${dest}`;

        attachDragHandlers(li);
        list.appendChild(li);
      });

      attachListDropHandlers(list);
      editGrid.appendChild(col);
    });
  }

  function attachDragHandlers(li) {
    // EWOT: Sets up drag handlers for items already assigned to a run.
    li.addEventListener("dragstart", (e) => {
      draggedItem = li;
      draggedItemType = "run-item";
      e.dataTransfer.effectAllowed = "move";
    });

    li.addEventListener("dragend", () => {
      draggedItem = null;
      draggedItemType = null;
      clearDragOverStates();
    });

    li.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      li.classList.add("drag-over");
    });

    li.addEventListener("dragleave", () => {
      li.classList.remove("drag-over");
    });

    li.addEventListener("drop", async (e) => {
      e.preventDefault();
      li.classList.remove("drag-over");
      if (!draggedItem || draggedItem === li || draggedItemType !== "run-item") return;

      const list = li.parentElement;
      list.insertBefore(draggedItem, li);
      await saveCurrentLayout();
    });
  }

  function attachListDropHandlers(list) {
    // EWOT: Handles drops into the run column list for both run-items and unassigned rows.
    list.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });

    list.addEventListener("drop", async (e) => {
      e.preventDefault();
      if (!draggedItem) return;

      const col = list.closest(".run-edit-column");
      if (!col) return;
      const runId = parseInt(col.getAttribute("data-run-id"), 10);
      if (!runId) return;

      if (draggedItemType === "run-item") {
        list.appendChild(draggedItem);
        await saveCurrentLayout();
      } else if (draggedItemType === "unassigned") {
        const flightId = parseInt(
          draggedItem.getAttribute("data-flight-id"),
          10
        );
        if (!flightId) return;
        await assignUnassignedFlightToRun(runId, flightId);
      }

      draggedItem = null;
      draggedItemType = null;
      clearDragOverStates();
    });
  }

  function attachUnassignedDragHandlers(row) {
    // EWOT: Sets up drag for unassigned flight rows so they can be dropped into run columns.
    row.addEventListener("dragstart", (e) => {
      draggedItem = row;
      draggedItemType = "unassigned";
      e.dataTransfer.effectAllowed = "move";
    });

    row.addEventListener("dragend", () => {
      draggedItem = null;
      draggedItemType = null;
      clearDragOverStates();
    });
  }

  function clearDragOverStates() {
    // EWOT: Clears visual drag-over markers from all run items.
    document
      .querySelectorAll(".run-edit-item.drag-over")
      .forEach((el) => el.classList.remove("drag-over"));
  }

  async function saveCurrentLayout() {
    // EWOT: Reads the current run columns layout and posts it to /api/runs/update_layout.
    const dateVal = dateInput.value;
    if (!dateVal) return;

    const runsPayload = [];
    const columns = editGrid.querySelectorAll(".run-edit-column");

    columns.forEach((col) => {
      const runId = col.getAttribute("data-run-id");
      const list = col.querySelector(".run-edit-list");
      const items = list ? Array.from(list.querySelectorAll(".run-edit-item")) : [];
      const frIds = items.map((li) =>
        parseInt(li.getAttribute("data-flight-run-id"), 10)
      );
      runsPayload.push({
        id: parseInt(runId, 10),
        flight_run_ids: frIds,
      });
    });

    const body = {
      date: dateVal,
      runs: runsPayload,
    };

    setStatus("Saving layout…");

    try {
      const url = `${apiBase}/api/runs/update_layout`;
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
        throw new Error(data.error || "Unknown error from update_layout");
      }
      setStatus(
        `Layout saved (${data.updated_flight_runs} flight runs updated).`
      );
      await loadRuns();
      renderRunCards();
      if (editToggle.checked) {
        buildEditGrid();
      }
      await updateUnassignedFlights(dateVal);
    } catch (err) {
      console.error("Failed to save layout", err);
      setStatus("Error saving layout.", true);
    }
  }

  async function assignUnassignedFlightToRun(runId, flightId) {
    // EWOT: Calls /api/flight_runs/assign to add an unassigned flight into a run, then reloads runs and unassigned list.
    if (!runId || !flightId) return;
    const dateVal = dateInput.value;
    setStatus(`Assigning flight ${flightId} to run ${runId}…`);

    try {
      const url = `${apiBase}/api/flight_runs/assign`;
      const body = {
        run_id: runId,
        flight_id: flightId,
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
        throw new Error(data.error || "Unknown error from assign endpoint");
      }

      setStatus(`Flight assigned to run. Reloading…`);

      await loadRuns();
      renderRunCards();
      if (editToggle && editToggle.checked) {
        buildEditGrid();
      }
      await updateUnassignedFlights(dateVal);
    } catch (err) {
      console.error("Failed to assign unassigned flight", err);
      setStatus("Error assigning flight. Check backend logs.", true);
    }
  }

  async function updateUnassignedFlights(dateVal) {
    // EWOT: Loads all flights for the date and shows those not present in any run.
    if (!unassignedSection || !unassignedTableBody) return;
    if (!dateVal) {
      unassignedSection.style.display = "none";
      return;
    }

    try {
      const url = `${apiBase}/api/flights?date=${encodeURIComponent(dateVal)}`;
      const res = await fetchApiStatus(url);
      if (!res.ok) {
        throw new Error(formatApiError("Flights", res));
      }
      const data = res.data || {};
      if (!data.ok) {
        throw new Error(
          formatApiError("Flights", { status: res.status, error: data.error })
        );
      }

      const flights = data.flights || [];

      const assignedIds = new Set();
      currentRuns.forEach((run) => {
        (run.flights || []).forEach((fr) => {
          if (typeof fr.flight_id === "number") {
            assignedIds.add(fr.flight_id);
          } else if (fr.flight && typeof fr.flight.id === "number") {
            assignedIds.add(fr.flight.id);
          }
        });
      });

      const unassigned = flights.filter((f) => !assignedIds.has(f.id));

      if (unassigned.length === 0) {
        unassignedSection.style.display = "none";
        unassignedTableBody.innerHTML = "";
        if (unassignedSummary) {
          unassignedSummary.textContent = "All flights are assigned to runs.";
        }
        return;
      }

      unassignedSection.style.display = "block";
      unassignedTableBody.innerHTML = "";

      if (unassignedSummary) {
        unassignedSummary.textContent =
          `Unassigned flights for this date: ${unassigned.length}`;
      }

      unassigned.sort((a, b) => {
        const at = a.time_local || "";
        const bt = b.time_local || "";
        if (at < bt) return -1;
        if (at > bt) return 1;
        const af = a.flight_number || "";
        const bf = b.flight_number || "";
        return af.localeCompare(bf);
      });

      unassigned.forEach((f) => {
        const tr = document.createElement("tr");
        tr.className = "unassigned-row";
        tr.setAttribute("draggable", "true");
        tr.setAttribute("data-flight-id", f.id);

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

        attachUnassignedDragHandlers(tr);
        unassignedTableBody.appendChild(tr);
      });
    } catch (err) {
      console.error("Failed to load unassigned flights", err);
      unassignedSection.style.display = "none";
    }
  }

  async function autoAssignRuns() {
    // EWOT: Calls backend auto-assignment for the day, then reloads runs and unassigned panel.
    const dateVal = dateInput.value;
    if (!dateVal) {
      setStatus("Please select a date before auto-assigning.");
      return;
    }

    const confirmMsg =
      `Auto-assign runs for ${dateVal}? This will rebuild assignments according to backend rules.`;
    const ok = window.confirm(confirmMsg);
    if (!ok) return;

    setStatus("Auto-assigning runs…");

    try {
      const url = `${apiBase}/api/assignments/generate`;
      const body = {
        date: dateVal,
        respect_existing_runs: false
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
      const unassignedCount = (data.unassigned_flight_ids || []).length;
      setStatus(
        `Auto-assigned ${assigned} flights. Unassigned: ${unassignedCount}. Reloading runs…`
      );

      await loadRuns();
      renderRunCards();
      if (editToggle && editToggle.checked) {
        buildEditGrid();
      }
      await updateUnassignedFlights(dateVal);
    } catch (err) {
      console.error("Failed to auto-assign runs", err);
      setStatus("Error during auto-assignment. Check backend logs.", true);
    }
  }

  // Event wiring
  refreshButton.addEventListener("click", async () => {
    const dateVal = dateInput.value;
    await loadRuns();
    if (editToggle.checked) {
      buildEditGrid();
    }
    await updateUnassignedFlights(dateVal);
  });

  if (autoAssignButton) {
    autoAssignButton.addEventListener("click", autoAssignRuns);
  }

  dateInput.addEventListener("change", async () => {
    const dateVal = dateInput.value;
    await loadRuns();
    if (editToggle.checked) {
      buildEditGrid();
    }
    await updateUnassignedFlights(dateVal);
  });

  operatorSelect.addEventListener("change", () => {
    renderRunCards();
    if (editToggle.checked) {
      buildEditGrid();
    }
    // Note: unassigned panel is per date, not per operator.
  });

  editToggle.addEventListener("change", () => {
    if (editToggle.checked) {
      editGrid.style.display = "flex";
      buildEditGrid();
    } else {
      editGrid.style.display = "none";
    }
  });

  // Initial load
  setDefaultDate();
  loadRuns().then(() => {
    const dateVal = dateInput.value;
    if (editToggle.checked) {
      buildEditGrid();
    }
    updateUnassignedFlights(dateVal);
  });
})();
