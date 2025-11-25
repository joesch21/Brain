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
    if (t.includes("machine room") || t.includes("machine-room")) {
      return { type: "nav", target: "/machine-room" };
    }
    if (t.includes("know") || t.includes("knowledge")) {
      // Anything after the word "know" becomes the question, if present.
      const m = t.split("know").pop().trim();
      return {
        type: "know",
        question: m || raw, // fallback to full phrase
      };
    }

    // --- NEW: create employee commands ---
    if (
      t.includes("add new employee") ||
      t.includes("create employee") ||
      t.includes("new crew") ||
      t.includes("add crew")
    ) {
      return { type: "nav", target: "/employees/new" };
    }

    // --- NEW: create flight commands ---
    if (
      t.includes("add new flight") ||
      t.includes("create flight") ||
      t.includes("schedule a flight") ||
      t.includes("schedule new flight")
    ) {
      return { type: "nav", target: "/flights/new" };
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
      if (
        (cmd.target === "/employees/new" || cmd.target === "/flights/new") &&
        window.CURRENT_ROLE &&
        window.CURRENT_ROLE !== "supervisor"
      ) {
        speak("You need supervisor role to create new records.");
        return;
      }
      if (
        (cmd.target === "/machine-room" || cmd.target === "/machine_room") &&
        window.CURRENT_ROLE &&
        window.CURRENT_ROLE !== "supervisor"
      ) {
        speak(
          "That action needs supervisor access. You can still view the roster and schedule."
        );
        return;
      }
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

  // Conversational flow state
  let pendingCommand = null;
  let pendingRawInput = null;

  // Turn a parsed command into a natural sentence for reflection.
  function summarizeCommandForSpeech(cmd, raw) {
    if (!cmd) return raw;

    if (cmd.type === "nav") {
      switch (cmd.target) {
        case "/roster":
          return "to open the roster page";
        case "/schedule":
          return "to open the flight schedule";
        case "/maintenance":
          return "to open the truck maintenance page";
        case "/build":
          return "to open the build workspace";
        case "/fix":
          return "to open the fix workspace";
        case "/know":
          return "to open the Know page";
        case "/machine-room":
        case "/machine_room":
          return "to open the machine room overview";
        default:
          return `to go to ${cmd.target}`;
      }
    }

    if (cmd.type === "know") {
      if (cmd.question && cmd.question.trim()) {
        return `to ask Know: “${cmd.question}”`;
      }
      return "to ask Know a question";
    }

    return raw;
  }

  // Step 2: handle the initial user request after greeting.
  function handleUserRequest(transcript) {
    pendingRawInput = transcript;

    const cmd = interpretCommand(transcript);
    if (!cmd) {
      speak(
        `I heard: “${transcript}”, but I'm not sure what to do with that. ` +
          "You can ask me to open roster, schedule, build, fix, Know, or machine room."
      );
      // Offer another try
      setTimeout(() => {
        speak("What can I help you with today?");
        listenOnce(handleUserRequest);
      }, 700);
      return;
    }

    pendingCommand = cmd;
    const summary = summarizeCommandForSpeech(cmd, transcript);

    speak(`You want ${summary}. Is that correct?`);
    // Now wait for yes/no confirmation
    listenOnce(handleConfirmation);
  }

  // Step 3: confirmation yes/no
  function handleConfirmation(transcript) {
    const t = transcript.toLowerCase();
    console.log("[voice] confirmation heard:", t);

    if (!pendingCommand) {
      // No pending command; restart flow
      speak("Let's start again. What can I help you with today?");
      listenOnce(handleUserRequest);
      return;
    }

    const positive =
      t.startsWith("yes") ||
      t.includes("correct") ||
      t.includes("that's right") ||
      t.includes("that is right");

    const negative =
      t.startsWith("no") ||
      t.includes("not quite") ||
      t.includes("that's wrong");

    if (positive) {
      speak("Okay, I'll do that.");
      // Execute the command
      runCommand(pendingCommand);
      pendingCommand = null;
      pendingRawInput = null;
      return;
    }

    if (negative) {
      speak("No problem. Let's try again. What can I help you with today?");
      pendingCommand = null;
      pendingRawInput = null;
      listenOnce(handleUserRequest);
      return;
    }

    // Ambiguous response: treat as “no” and re-prompt
    speak("I'm not sure I understood. Let's try again. What can I help you with today?");
    pendingCommand = null;
    pendingRawInput = null;
    listenOnce(handleUserRequest);
  }

  // Entry point for the conversational assistant
  function startAssistantFlow() {
    if (!SpeechRecognition) {
      alert("Your browser doesn't support voice recognition yet.");
      return;
    }
    speak("What can I help you with today?");
    listenOnce(handleUserRequest);
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
    startAssistantFlow,
  };
})();
