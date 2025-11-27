// static/js/voice.js
(function () {
  let recognition = null;
  let selectedVoice = null;
  let availableVoices = [];
  let voicesLoaded = false;
  const voiceReadyCallbacks = [];

  const PREFERRED_VOICE_KEY = "brain_preferred_voice";

  function getPreferredVoiceName() {
    try {
      return localStorage.getItem(PREFERRED_VOICE_KEY);
    } catch (err) {
      console.warn("[voice] Unable to read preferred voice", err);
      return null;
    }
  }

  function setPreferredVoiceName(name) {
    try {
      if (name) {
        localStorage.setItem(PREFERRED_VOICE_KEY, name);
      } else {
        localStorage.removeItem(PREFERRED_VOICE_KEY);
      }
      // Re-evaluate selection once the preference changes
      selectVoiceFromAvailable();
    } catch (err) {
      console.warn("[voice] Unable to save preferred voice", err);
    }
  }

  function choosePreferredVoice(voices) {
    if (!voices || !voices.length) return null;

    const preferredName = getPreferredVoiceName();
    if (preferredName) {
      const preferred = voices.find((voice) => voice.name === preferredName);
      if (preferred) return preferred;
    }

    // 1) Try specific nice voices if they exist
    const preferredNames = [
      "Google UK English Female",
      "Google US English Female",
      "Google UK English Male",
      "Google US English",
      "Microsoft Zira Desktop - English (United States)",
      "Microsoft David Desktop - English (United States)",
    ];
    for (const name of preferredNames) {
      const v = voices.find((voice) => voice.name === name);
      if (v) return v;
    }

    // 2) Otherwise, pick the first English voice
    const english = voices.find(
      (v) => v.lang && v.lang.toLowerCase().startsWith("en")
    );
    if (english) return english;

    // 3) Fallback: first voice in the list
    return voices[0];
  }

  function selectVoiceFromAvailable() {
    if (!availableVoices.length) return null;
    selectedVoice = choosePreferredVoice(availableVoices);
    console.log("[voice] selected voice:", selectedVoice && selectedVoice.name);
    return selectedVoice;
  }

  function initVoices() {
    if (!window.speechSynthesis) return;

    function loadVoices() {
      const voices = window.speechSynthesis.getVoices();
      if (!voices || !voices.length) return;
      availableVoices = voices;
      voicesLoaded = true;
      selectVoiceFromAvailable();
      while (voiceReadyCallbacks.length) {
        const cb = voiceReadyCallbacks.shift();
        try {
          cb(availableVoices, selectedVoice);
        } catch (err) {
          console.warn("[voice] callback error", err);
        }
      }
    }

    // Some browsers fire onvoiceschanged, others already have voices loaded
    window.speechSynthesis.onvoiceschanged = loadVoices;
    loadVoices();
  }

  // Call this once when the script loads
  initVoices();

  function ensureRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      return null; // handled by startListening
    }
    if (!recognition) {
      recognition = new SR();
      recognition.lang = "en-US";
      recognition.continuous = false;
      recognition.interimResults = false;
    }
    return recognition;
  }

  // Tiny helper to show what we heard and how we interpreted it on the Know page.
  function updateKnowTranscript(heard, understood) {
    const el = document.getElementById("know-voice-transcript");
    if (!el) return;

    if (!heard && !understood) {
      el.textContent = "";
      return;
    }

    if (understood) {
      el.textContent = `Heard: “${heard}” → Understood: ${understood}`;
    } else {
      el.textContent = `Heard: “${heard}”`;
    }
  }

  function getCurrentRole() {
    return (window.CURRENT_ROLE || "").toLowerCase();
  }

  function hasRoleAccess(allowedRoles) {
    if (!allowedRoles || !allowedRoles.length) return true;
    const role = getCurrentRole();
    return allowedRoles.includes(role);
  }

  // Text-to-speech for friendly responses.
  function speak(text) {
    if (!window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(String(text));

    // Use the selected voice if available
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }

    // Tune the “personality” a bit
    utterance.rate = 1.0; // 0.8 = slower/calm, 1.2 = faster/urgent
    utterance.pitch = 1.0; // 0.8 = deeper, 1.2 = brighter

    window.speechSynthesis.speak(utterance);
  }

  function setListeningState(isListening) {
    const heroBtn = document.getElementById("voice-hero-button");
    if (heroBtn) {
      heroBtn.classList.toggle("is-listening", isListening);
    }

    const headerBtn = document.getElementById("voice-command-btn");
    if (headerBtn) {
      headerBtn.classList.toggle("is-listening", isListening);
    }

    const label = window.voiceStatusLabel || document.getElementById("voice-status-label");
    if (label) {
      label.textContent = isListening ? "Listening..." : "Ready to listen";
    }
  }

  // Listen for a single utterance and resolve with the transcript.
  function listenOnce() {
    return new Promise((resolve, reject) => {
      const rec = ensureRecognition();
      if (!rec) {
        reject(new Error("SpeechRecognition not available"));
        return;
      }

      rec.onresult = (event) => {
        setListeningState(false);
        const transcript = event.results[0][0].transcript.trim();
        console.log("[voice] listenOnce heard:", transcript);
        resolve(transcript);
      };

      rec.onerror = (event) => {
        console.error("[voice] listenOnce error:", event.error);
        setListeningState(false);
        reject(event.error || new Error("speech error"));
      };

      rec.onend = () => {
        setListeningState(false);
      };

      try {
        setListeningState(true);
        rec.start();
      } catch (err) {
        console.error("[voice] listenOnce start error:", err);
        setListeningState(false);
        reject(err);
      }
    });
  }

  function normalizeMaintenanceStatus(text) {
    if (!text) return "";
    const t = text.toLowerCase();
    if (t.includes("out of service") || t.includes("broken") || t.includes("not working")) {
      return "Out of service";
    }
    if (t.includes("due") || t.includes("needs service") || t.includes("service due")) {
      return "Due";
    }
    if (t.includes("complete") || t.includes("completed") || t.includes("fixed") || t.includes("repaired")) {
      return "Completed";
    }
    if (t.includes("ok") || t.includes("okay") || t.includes("fine")) {
      return "OK";
    }
    return text.trim();
  }

  function extractTruckIdFromSpeech(text) {
    if (!text) return "";
    const t = text.toLowerCase();
    // Look for "truck X" pattern
    const match = t.match(/truck\s+([a-z0-9\-]+)/);
    if (match && match[1]) {
      return match[1].toUpperCase();
    }
    return "";
  }

  function backendUrl(path) {
    // If you later want a different host (e.g. Code_Crafter2 on another domain),
    // set window.BRAIN_BACKEND_BASE_URL in _layout.html and it will prefix requests.
    const base = window.BRAIN_BACKEND_BASE_URL || "";
    return base + path;
  }

  function humanizeLastUpdated(isoString) {
    if (!isoString) return null;
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return null;

    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();

    const timePart = d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    const datePart = d.toLocaleDateString();

    if (sameDay) {
      return `today at ${timePart}`;
    }
    return `${datePart} at ${timePart}`;
  }

  function formatISODate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function parseSpokenDateToISO(text) {
    if (!text) return "";
    const t = text.toLowerCase().trim();
    if (!t || t === "skip" || t === "no" || t === "none" || t === "blank") {
      return "";
    }

    const now = new Date();

    if (t.includes("today")) {
      return formatISODate(now);
    }

    if (t.includes("tomorrow")) {
      const d = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      return formatISODate(d);
    }

    const inDaysMatch = t.match(/in\s+(\d+)\s+day/);
    if (inDaysMatch && inDaysMatch[1]) {
      const n = parseInt(inDaysMatch[1], 10);
      if (!isNaN(n)) {
        const d = new Date(now.getTime() + n * 24 * 60 * 60 * 1000);
        return formatISODate(d);
      }
    }

    // Direct ISO form e.g. "2025-11-27"
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
      return t;
    }

    return "";
  }

  // Interpret raw speech into a command.
  function interpretCommand(raw) {
    const t = raw.toLowerCase();

    // NAVIGATION: home
    if (t.includes("home") || t.includes("dashboard")) {
      return { type: "nav", target: "/" };
    }

    // NAVIGATION: roster / staff / employees
    if (
      t.includes("roster") ||
      t.includes("staff") ||
      t.includes("employees") ||
      t.includes("team")
    ) {
      return { type: "nav", target: "/roster" };
    }

    // NAVIGATION: schedule / flights
    if (
      t.includes("schedule") ||
      t.includes("flights") ||
      t.includes("flight board") ||
      t.includes("today's flights") ||
      t.includes("todays flights")
    ) {
      return { type: "nav", target: "/schedule" };
    }

    // NAVIGATION: maintenance / trucks
    if (
      t.includes("maintenance") ||
      t.includes("truck maintenance") ||
      t.includes("trucks")
    ) {
      return { type: "nav", target: "/maintenance" };
    }

    // NAVIGATION: machine room / logs / recent changes
    if (
      t.includes("machine room") ||
      t.includes("machine-room") ||
      t.includes("logs") ||
      t.includes("activity") ||
      t.includes("recent changes")
    ) {
      return { type: "nav", target: "/machine-room" };
    }

    // NAVIGATION: build / fix
    if (t.includes("build")) {
      return { type: "nav", target: "/build" };
    }
    if (t.includes("fix") || t.includes("debug")) {
      return { type: "nav", target: "/fix" };
    }

    // ACTION: start maintenance wizard for a broken truck
    if (
      t.includes("broken truck") ||
      t.includes("truck is broken") ||
      t.includes("report broken truck") ||
      (t.includes("log") && t.includes("maintenance"))
    ) {
      return {
        type: "action",
        action: "maintenance_wizard",
        restricted: true,
        allowedRoles: ["admin", "supervisor"],
      };
    }

    // ACTION: update maintenance status for a truck
    if (
      (t.includes("mark truck") || t.includes("set truck")) &&
      (t.includes("completed") ||
        t.includes("complete") ||
        t.includes("out of service") ||
        t.includes("broken") ||
        t.includes("due") ||
        t.includes("okay") ||
        t.includes("ok"))
    ) {
      const truckId = extractTruckIdFromSpeech(t);
      const status = normalizeMaintenanceStatus(t);

      if (truckId && status) {
        return {
          type: "action",
          action: "maintenance_status_update",
          truckId,
          status,
          restricted: true,
          allowedRoles: ["supervisor", "admin"],
        };
      }
    }

    // ACTION: bulk update maintenance status for a truck
    if (
      (t.includes("mark all maintenance") ||
        t.includes("mark all items") ||
        t.includes("close all maintenance") ||
        t.includes("close all items")) &&
      t.includes("truck")
    ) {
      const truckId = extractTruckIdFromSpeech(t);
      let status = normalizeMaintenanceStatus(t);
      let onlyDue = false;

      // e.g. "close all due items for truck 3"
      if (t.includes("close all due")) {
        onlyDue = true;
        // Here "due" describes current state; treat target as Completed.
        if (status === "Due") {
          status = "Completed";
        }
      } else if (t.includes("due items") || t.includes("only due")) {
        // e.g. "mark all due items completed for truck 3"
        onlyDue = true;
      }

      if (truckId && status) {
        return {
          type: "action",
          action: "maintenance_status_update_bulk",
          truckId,
          status,
          onlyDue,
          restricted: true,
          allowedRoles: ["supervisor", "admin"],
        };
      }
    }

    // ACTION: query maintenance status for a truck
    if (
      (t.includes("status of truck") ||
        (t.includes("truck") && t.includes("status"))) &&
      (t.includes("what's") || t.includes("what is") || t.includes("whats"))
    ) {
      const truckId = extractTruckIdFromSpeech(t);
      if (truckId) {
        return {
          type: "action",
          action: "maintenance_status_query",
          truckId,
          restricted: true,
          allowedRoles: ["supervisor", "admin"],
        };
      }
    }

    // KNOWLEDGE / STATUS QUERIES
    if (t.includes("know") || t.includes("knowledge")) {
      const idx = t.indexOf("know");
      const q = idx >= 0 ? raw.slice(idx + "know".length).trim() : raw;
      return { type: "know", question: q || raw };
    }

    if (t.includes("status of") || t.startsWith("what's the status")) {
      const idx = t.indexOf("status of");
      const q = idx >= 0 ? raw.slice(idx + "status of".length).trim() : raw;
      return { type: "know", question: q || raw };
    }

    // If on /know and no keyword, treat the entire utterance as the question.
    if (window.location.pathname.startsWith("/know")) {
      return { type: "know", question: raw };
    }

    // RESTRICTED ACTIONS: require supervisor/admin

    // Add flight
    if (
      t.includes("add flight") ||
      t.includes("create flight") ||
      t.includes("new flight")
    ) {
      return {
        type: "action",
        action: "add_flight",
        restricted: true,
        allowedRoles: ["admin", "supervisor"],
      };
    }

    // Delete flight
    if (t.includes("delete flight")) {
      let flightId = null;
      const match = t.match(/delete flight\s+(\d+)/);
      if (match && match[1]) {
        flightId = match[1];
      }

      return {
        type: "action",
        action: "delete_flight",
        restricted: true,
        allowedRoles: ["admin", "supervisor"],
        flightId,
      };
    }

    return null;
  }

  // Execute the interpreted command.
  function runCommand(cmd, raw) {
    if (!cmd) {
      // Unknown command – update transcript on Know page and prompt again.
      if (window.location.pathname.startsWith("/know")) {
        updateKnowTranscript(raw, "not sure what to do with that");
      }
      speak(
        "I heard you, but I'm not sure what to do with that. " +
          "Try saying: open roster, show me today’s flights, open machine room, " +
          "or ask Know about truck maintenance."
      );
      return;
    }

    // Early permission gate for restricted commands
    if (cmd.restricted && !hasRoleAccess(cmd.allowedRoles)) {
      speak(
        "You don't have permission to do that. " +
          "Please ask a supervisor or admin."
      );
      return;
    }

    if (cmd.type === "nav") {
      let label = "that page";
      switch (cmd.target) {
        case "/":
          label = "the dashboard";
          break;
        case "/roster":
          label = "the roster";
          break;
        case "/schedule":
          label = "the flight schedule";
          break;
        case "/maintenance":
          label = "the maintenance page";
          break;
        case "/machine-room":
          label = "the machine room";
          break;
        case "/build":
          label = "the build workspace";
          break;
        case "/fix":
          label = "the fix workspace";
          break;
      }
      speak(`Okay, opening ${label}.`);
      window.location.href = cmd.target;
      return;
    }

    if (cmd.type === "know") {
      const q = (cmd.question || "").trim();
      if (!q) {
        speak("I couldn't hear a clear question for Know.");
        return;
      }

      // Try to find the question input on the Know page.
      const inputEl =
        document.getElementById("question-input") ||
        document.getElementById("know-question-input") ||
        document.querySelector("[name=question]");

      if (inputEl) {
        inputEl.value = q;
        inputEl.focus();
        inputEl.setSelectionRange(q.length, q.length);

        updateKnowTranscript(raw, `ask Know: “${q}”`);

        const form =
          document.getElementById("know-form") ||
          inputEl.form ||
          null;

        if (form) {
          speak(`Okay, I'll ask: ${q}`);
          // Let the existing JS / backend handle the submission.
          if (form.requestSubmit) {
            form.requestSubmit();
          } else {
            form.submit();
          }
        } else {
          speak(
            "I filled in your question, but I couldn't find a form to submit it."
          );
        }
      } else {
        updateKnowTranscript(raw, "could not find Know input field");
        speak(
          "I heard your question but couldn't find the Know question box on this page."
        );
      }

      return;
    }

    if (cmd.type === "action") {
      handleActionCommand(cmd, raw);
      return;
    }
  }

  function sendMaintenanceStatusUpdate(truckId, status) {
    if (!truckId || !status) {
      speak("I need both a truck ID and a status to update.");
      return;
    }

    fetch(backendUrl("/api/maintenance/voice_status"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        truck_id: truckId,
        status: status,
      }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then((result) => {
        if (!result.ok || !result.data.ok) {
          const msg =
            (result.data && result.data.error) ||
            "The server could not update that truck.";
          console.error("[voice] maintenance_status_update error:", msg);
          speak(msg);
          return;
        }

        const item = result.data.item || {};
        const s = item.status || status;
        speak(
          `Okay, I updated truck ${item.truck_id || truckId} to status ${s}.`
        );

        // If we're on the maintenance list, refresh so the change is visible.
        const path = window.location.pathname || "";
        if (path.startsWith("/maintenance") && !path.includes("/new")) {
          setTimeout(() => {
            window.location.reload();
          }, 800);
        }
      })
      .catch((err) => {
        console.error("[voice] maintenance_status_update fetch error:", err);
        speak("I couldn't reach the server to update that truck.");
      });
  }

  function sendMaintenanceStatusBulkUpdate(truckId, status, onlyDue) {
    if (!truckId || !status) {
      speak("I need both a truck ID and a status to update.");
      return;
    }

    fetch(backendUrl("/api/maintenance/voice_status_bulk"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        truck_id: truckId,
        status: status,
        only_due: !!onlyDue,
      }),
    })
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then((result) => {
        if (!result.ok || !result.data.ok) {
          const msg =
            (result.data && result.data.error) ||
            "The server could not update those maintenance items.";
          console.error("[voice] maintenance_status_bulk error:", msg);
          speak(msg);
          return;
        }

        const updatedCount = result.data.updated_count || 0;
        const s = result.data.status || status;
        const truck = result.data.truck_id || truckId;

        if (updatedCount === 0) {
          speak(
            `I didn't find any maintenance items to update for truck ${truck}.`
          );
          return;
        }

        if (onlyDue) {
          speak(
            `Okay, I updated ${updatedCount} due maintenance item${updatedCount === 1 ? "" : "s"} ` +
              `for truck ${truck} to status ${s}.`
          );
        } else {
          speak(
            `Okay, I updated ${updatedCount} maintenance item${updatedCount === 1 ? "" : "s"} ` +
              `for truck ${truck} to status ${s}.`
          );
        }

        // If we're on the maintenance list, refresh so the change is visible.
        const path = window.location.pathname || "";
        if (path.startsWith("/maintenance") && !path.includes("/new")) {
          setTimeout(() => {
            window.location.reload();
          }, 800);
        }
      })
      .catch((err) => {
        console.error("[voice] maintenance_status_bulk fetch error:", err);
        speak("I couldn't reach the server to update those maintenance items.");
      });
  }

  function sendMaintenanceStatusQuery(truckId) {
    if (!truckId) {
      speak("I need a truck ID to check its status.");
      return;
    }

    const url =
      backendUrl("/api/maintenance/status_summary") +
      "?truck_id=" +
      encodeURIComponent(truckId);

    fetch(url)
      .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
      .then((result) => {
        if (!result.ok || !result.data.ok) {
          const msg =
            (result.data && result.data.error) ||
            `I couldn't find any maintenance items for truck ${truckId}.`;
          console.error("[voice] maintenance_status_summary error:", msg);
          speak(msg);
          return;
        }

        const data = result.data;
        const total = (data.counts && data.counts.total) || 0;
        const currentStatus = data.current_status || "unknown";
        const lastUpdatedHuman = humanizeLastUpdated(data.last_updated);
        const truck = data.truck_id || truckId;

        let message = `Truck ${truck} has ${total} maintenance item${
          total === 1 ? "" : "s"
        }. Latest status is ${currentStatus}`;

        if (lastUpdatedHuman) {
          message += `, last updated ${lastUpdatedHuman}.`;
        } else {
          message += ".";
        }

        speak(message);
      })
      .catch((err) => {
        console.error("[voice] maintenance_status_summary fetch error:", err);
        speak("I couldn't reach the server to check that truck's status.");
      });
  }

  function handleActionCommand(cmd, raw) {
    if (cmd.action === "add_flight") {
      speak("Opening the new flight form.");
      window.location.href = "/flights/new";
      return;
    }

    if (cmd.action === "delete_flight") {
      if (!cmd.flightId) {
        speak(
          "I heard you want to delete a flight, but I didn't catch which one. " +
            "Please say delete flight followed by the flight number."
        );
        return;
      }

      speak(
        `Okay, I'll open the delete confirmation for flight ${cmd.flightId}.`
      );
      window.location.href = `/flights/${encodeURIComponent(
        cmd.flightId
      )}/confirm-delete`;
      return;
    }

    if (cmd.action === "maintenance_wizard") {
      const path = window.location.pathname || "";
      // If we're already on the new maintenance form, start immediately.
      if (path.startsWith("/maintenance") && path.includes("/new")) {
        speak("Okay, let's log a broken truck together.");
        if (window.voice && typeof window.voice.startMaintenanceFlow === "function") {
          window.voice.startMaintenanceFlow();
        }
      } else {
        speak("Opening the new maintenance form so we can log a broken truck.");
        window.location.href = "/maintenance/new?voice=1";
      }
      return;
    }

    if (cmd.action === "maintenance_status_update") {
      const truckId = cmd.truckId;
      const status = cmd.status;
      if (!truckId || !status) {
        speak("I couldn't understand which truck or status you wanted.");
        return;
      }
      speak(
        `Updating maintenance status for truck ${truckId} to ${status}.`
      );
      sendMaintenanceStatusUpdate(truckId, status);
      return;
    }

    if (cmd.action === "maintenance_status_update_bulk") {
      const truckId = cmd.truckId;
      const status = cmd.status;
      const onlyDue = !!cmd.onlyDue;
      if (!truckId || !status) {
        speak("I couldn't understand which truck or status you wanted to change.");
        return;
      }

      if (onlyDue) {
        speak(
          `Updating all due maintenance items for truck ${truckId} to status ${status}.`
        );
      } else {
        speak(
          `Updating all maintenance items for truck ${truckId} to status ${status}.`
        );
      }

      sendMaintenanceStatusBulkUpdate(truckId, status, onlyDue);
      return;
    }

    if (cmd.action === "maintenance_status_query") {
      const truckId = cmd.truckId;
      if (!truckId) {
        speak("I couldn't tell which truck you meant.");
        return;
      }
      speak(`Checking maintenance status for truck ${truckId}.`);
      sendMaintenanceStatusQuery(truckId);
      return;
    }

    speak("I heard an action, but I'm not sure how to handle it yet.");
  }

  // One-shot assistant flow: greet, listen, interpret, act.
  function startListening() {
    // Always greet first so the user gets immediate feedback
    speak("What can I help you with today?");

    const rec = ensureRecognition();
    if (!rec) {
      console.warn("[voice] SpeechRecognition not available in this browser");
      const label =
        window.voiceStatusLabel || document.getElementById("voice-status-label");
      if (label) {
        label.textContent = "Voice input not supported on this browser";
      }
      return;
    }

    setListeningState(true);

    rec.onresult = (event) => {
      setListeningState(false);
      const transcript = event.results[0][0].transcript.trim();
      console.log("[voice] heard:", transcript);

      const cmd = interpretCommand(transcript);

      // Update transcript immediately if we're on /know or issuing a know command.
      if (
        window.location.pathname.startsWith("/know") ||
        (cmd && cmd.type === "know")
      ) {
        let understood = null;
        if (!cmd) {
          understood = "not sure what to do with that";
        } else if (cmd.type === "nav") {
          understood = `navigate to ${cmd.target}`;
        } else if (cmd.type === "know") {
          const q = (cmd.question || "").trim();
          understood = q ? `ask Know: “${q}”` : "ask Know a question";
        }
        updateKnowTranscript(transcript, understood);
      }

      runCommand(cmd, transcript);
    };

    rec.onerror = (event) => {
      console.error("[voice] error:", event.error);
      setListeningState(false);
    };

    rec.onend = () => {
      setListeningState(false);
    };

    rec.start();
  }

  function onVoicesReady(cb) {
    if (voicesLoaded) {
      cb(availableVoices, selectedVoice);
    } else {
      voiceReadyCallbacks.push(cb);
    }
  }

  function formatVoiceLabel(voice) {
    if (!voice) return "";
    const langLabel = voice.lang ? ` (${voice.lang})` : "";
    return `${voice.name}${langLabel}`;
  }

  function initSettingsUI() {
    const card = document.getElementById("voice-preferences-card");
    if (!card) return;

    const select = document.getElementById("voice-select");
    const saveBtn = document.getElementById("voice-save");
    const messageEl = document.getElementById("voice-save-message");
    const unsupportedEl = document.getElementById("voice-unsupported");

    if (!window.speechSynthesis) {
      card.classList.add("is-disabled");
      if (unsupportedEl) {
        unsupportedEl.style.display = "block";
      }
      if (select) select.disabled = true;
      if (saveBtn) saveBtn.disabled = true;
      return;
    }

    function showMessage(text) {
      if (messageEl) {
        messageEl.textContent = text;
        messageEl.style.opacity = text ? "1" : "0";
      }
    }

    function populateSelect(voices) {
      if (!select) return;
      select.innerHTML = "";
      voices.forEach((voice) => {
        const opt = document.createElement("option");
        opt.value = voice.name;
        opt.textContent = formatVoiceLabel(voice);
        select.appendChild(opt);
      });

      const selectedName =
        getPreferredVoiceName() &&
        voices.some((v) => v.name === getPreferredVoiceName())
          ? getPreferredVoiceName()
          : selectedVoice && voices.some((v) => v.name === selectedVoice.name)
          ? selectedVoice.name
          : voices[0] && voices[0].name;

      if (selectedName) {
        select.value = selectedName;
      }

      select.disabled = false;
      if (saveBtn) {
        saveBtn.disabled = false;
      }
    }

    if (select) {
      select.innerHTML = "<option>Loading voices…</option>";
      select.disabled = true;
    }
    if (saveBtn) {
      saveBtn.disabled = true;
    }

    onVoicesReady((voices) => {
      populateSelect(voices);
      if (!messageEl) return;
      const preferredName = getPreferredVoiceName();
      messageEl.textContent = preferredName
        ? "Your preferred voice is ready."
        : "Voices loaded. Pick your favorite and save.";
      messageEl.style.opacity = "1";
    });

    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        if (!select || !select.value) return;
        setPreferredVoiceName(select.value);
        showMessage("Saved. All future prompts will use this voice in this browser.");
        // Optional quick preview so users know what they chose
        speak("This is your chosen voice.");
      });
    }
  }

  async function startMaintenanceFlow() {
    const path = window.location.pathname || "";
    const onMaintenanceForm =
      path.startsWith("/maintenance") && path.includes("/new");

    if (!onMaintenanceForm) {
      speak("We need to be on the maintenance form first. I'll open it now.");
      window.location.href = "/maintenance/new?voice=1";
      return;
    }

    const form = document.querySelector("form.cc-form") || document.querySelector("form");
    const truckInput = document.getElementById("truck_id");
    const dueInput = document.getElementById("due_date");
    const statusInput = document.getElementById("status");
    const descInput = document.getElementById("description");

    if (!form || !truckInput || !statusInput || !descInput) {
      speak("I couldn't find the maintenance form on this page.");
      return;
    }

    try {
      // 1) Truck ID
      speak("Let's log a broken truck. First, what is the truck ID?");
      let heard = await listenOnce();
      if (!heard) {
        speak("I didn't catch that truck ID. You can try again or fill it in by hand.");
        return;
      }
      truckInput.value = heard.trim().toUpperCase();
      truckInput.dispatchEvent(new Event("input", { bubbles: true }));

      // 2) Description
      speak("Got it. Briefly describe the problem.");
      heard = await listenOnce();
      if (heard) {
        descInput.value = heard.trim();
        descInput.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // 3) Status
      speak("What status should I set? You can say out of service, due, okay, or completed.");
      heard = await listenOnce();
      const normalizedStatus = normalizeMaintenanceStatus(heard || "");
      if (normalizedStatus) {
        statusInput.value = normalizedStatus;
        statusInput.dispatchEvent(new Event("input", { bubbles: true }));
      }

      // 4) Due date (optional)
      let dueStr = "";
      if (dueInput) {
        speak(
          "Optionally, say a due date like today, tomorrow, in three days, or say skip to leave it blank."
        );
        heard = await listenOnce();
        dueStr = parseSpokenDateToISO(heard || "");
        if (dueStr) {
          dueInput.value = dueStr;
          dueInput.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }

      // 5) Summary + confirmation
      const summaryParts = [];
      if (truckInput.value) summaryParts.push(`truck ${truckInput.value}`);
      if (statusInput.value) summaryParts.push(`status ${statusInput.value}`);
      if (dueStr) summaryParts.push(`due ${dueStr}`);
      if (descInput.value) summaryParts.push(`description: ${descInput.value}`);

      const summaryText =
        summaryParts.length > 0
          ? summaryParts.join(", ")
          : "no details filled in";

      speak(
        `Here is what I have: ${summaryText}. ` +
          "Say submit to save this maintenance item, or say cancel to stop."
      );

      heard = await listenOnce();
      const confirm = (heard || "").toLowerCase();
      if (
        confirm.includes("submit") ||
        confirm.includes("save") ||
        confirm.includes("yes")
      ) {
        speak("Okay, submitting the maintenance item.");
        if (form.requestSubmit) {
          form.requestSubmit();
        } else {
          form.submit();
        }
      } else {
        speak("Okay, I won't submit. You can review and submit manually.");
      }
    } catch (err) {
      console.error("[voice] maintenance flow error:", err);
      speak("Something went wrong while listening. You can fill in the form manually.");
    }
  }

  // Export global voice API
  window.voice = {
    startListening,
    speak,
    startMaintenanceFlow,
  };

  window.BrainVoicePreferences = {
    initSettingsUI,
  };
})();
