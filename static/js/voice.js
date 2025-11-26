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

  // Export global voice API
  window.voice = {
    startListening,
    speak,
  };

  window.BrainVoicePreferences = {
    initSettingsUI,
  };
})();
