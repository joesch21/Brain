// Voice control + text-to-speech for CodeCrafter dashboard.

(function () {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition || null;

  let recognition = null;

  function ensureRecognition() {
    if (!SpeechRecognition) {
      alert(
        "Your browser doesn't support speech recognition yet. Please use Chrome or Edge."
      );
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

  // Generic one-shot listener used by both dictation and command mode.
  function listenOnce(onResult) {
    const rec = ensureRecognition();
    if (!rec) return;

    rec.onresult = (event) => {
      const transcript = event.results[0][0].transcript.trim();
      console.log("[voice] heard:", transcript);
      if (typeof onResult === "function") onResult(transcript);
    };
    rec.onerror = (event) => {
      console.error("[voice] error:", event.error);
    };
    rec.start();
  }

  // --- Text-to-speech ---

  function speak(text) {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(String(text));
    u.rate = 1.0;
    u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }

  // --- Command parsing + routing ---

  function interpretCommand(raw) {
    const t = raw.toLowerCase();

    // Simple navigation intents
    if (t.includes("roster") || t.includes("staff")) {
      return { type: "nav", target: "/roster" };
    }
    if (t.includes("schedule") || t.includes("flight")) {
      return { type: "nav", target: "/schedule" };
    }
    if (t.includes("maintenance") || t.includes("truck")) {
      return { type: "nav", target: "/maintenance" };
    }
    if (t.includes("build")) {
      return { type: "nav", target: "/build" };
    }
    if (t.includes("fix")) {
      return { type: "nav", target: "/fix" };
    }
    if (t.includes("know") || t.includes("knowledge")) {
      // Anything after the word "know" becomes the question, if present.
      const m = t.split("know").pop().trim();
      return {
        type: "know",
        question: m || raw, // fallback to full phrase
      };
    }

    // Fallback: if on /know right now, treat it as a question
    if (window.location.pathname.startsWith("/know")) {
      return { type: "know", question: raw };
    }

    return null;
  }

  function runCommand(cmd) {
    if (!cmd) {
      speak("Sorry, I didn't catch a destination.");
      return;
    }

    if (cmd.type === "nav") {
      speak(`Opening ${cmd.target.replace("/", "")}.`);
      window.location.href = cmd.target;
      return;
    }

    if (cmd.type === "know") {
      if (!cmd.question || !cmd.question.trim()) {
        speak("What would you like to ask Know?");
        return;
      }
      // Fill the Know question field if present; otherwise navigate to /know.
      const input =
        document.getElementById("know-question-input") ||
        document.getElementById("question-input") ||
        document.querySelector("input[name=question]") ||
        document.querySelector("textarea[name=question]");

      if (input) {
        input.value = cmd.question;
        // Try to submit the form via JS if wired that way.
        const form = input.form;
        if (form) {
          const evt = new Event("submit", { cancelable: true });
          if (!form.dispatchEvent(evt)) {
            form.submit();
          }
        }
        speak("Asking Know.");
      } else {
        // Not on the Know page yet; go there with a query param.
        const url = new URL(window.location.origin + "/know");
        url.searchParams.set("q", cmd.question);
        speak("Opening Know.");
        window.location.href = url.toString();
      }
      return;
    }
  }

  // Public: start command mode (used by global mic)
  function startCommandListening() {
    listenOnce((transcript) => {
      const cmd = interpretCommand(transcript);
      runCommand(cmd);
    });
  }

  // Optional: simple dictation mode for focused input fields
  function startDictation() {
    listenOnce((transcript) => {
      const active =
        document.activeElement &&
        (document.activeElement.tagName === "INPUT" ||
          document.activeElement.tagName === "TEXTAREA");
      if (active) {
        document.activeElement.value = transcript;
      }
    });
  }

  window.voice = {
    speak,
    startCommandListening,
    startDictation,
  };
})();
