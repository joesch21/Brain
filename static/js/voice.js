// static/js/voice.js
(function () {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition || null;

  let recognition = null;

  function ensureRecognition() {
    if (!SpeechRecognition) {
      alert("Your browser doesn't support voice recognition yet.");
      return null;
    }
    if (!recognition) {
      recognition = new SpeechRecognition();
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

  // Text-to-speech for friendly responses.
  function speak(text) {
    if (!window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(String(text));
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
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
  }

  // One-shot assistant flow: greet, listen, interpret, act.
  function startListening() {
    const rec = ensureRecognition();
    if (!rec) return;

    speak("What can I help you with today?");

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

  // Export global voice API
  window.voice = {
    startListening,
    speak,
  };
})();
