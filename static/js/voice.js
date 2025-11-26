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

  // Interpret raw speech into a command.
  function interpretCommand(raw) {
    const t = raw.toLowerCase();

    // Navigation intents (extend later as needed)
    if (t.includes("build")) return { type: "nav", target: "/build" };
    if (t.includes("fix")) return { type: "nav", target: "/fix" };
    if (t.includes("home")) return { type: "nav", target: "/" };
    if (t.includes("know")) {
      const idx = t.indexOf("know");
      const q = raw.slice(idx + "know".length).trim() || raw;
      return { type: "know", question: q };
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
          "You can say things like: ask Know about today's flights, " +
          "or open build, or open fix."
      );
      return;
    }

    if (cmd.type === "nav") {
      speak("Okay, opening that for you.");
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

    rec.onresult = (event) => {
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
    };

    rec.start();
  }

  // Export global voice API
  window.voice = {
    startListening,
    speak,
  };
})();
