/*
 * Adds voice recognition (speech-to-text) and text-to-speech playback for the CodeCrafter UI using the Web Speech API.
 * This module exposes two functions on the global `voice` object:
 *   startListening() – prompts the browser to capture audio, transcribes it, populates the question input and submits the form;
 *   speak(text) – uses SpeechSynthesis to read a string aloud.
 */
(function() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  let recognition = null;

  // Launches speech recognition to capture a single phrase from the user and populate the chat input.
  // One sentence explanation: starts listening for voice input and submits the question once transcribed.
  function startListening() {
    if (!SpeechRecognition) {
      alert('Sorry, your browser does not support speech recognition. Please update or use keyboard input.');
      return;
    }
    if (!recognition) {
      recognition = new SpeechRecognition();
      recognition.lang = 'en-US';
      recognition.continuous = false;
      recognition.interimResults = false;
    }
    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript.trim();
      const inputEl = document.getElementById('question-input') || document.querySelector('input[name=question]');
      if (inputEl) {
        inputEl.value = transcript;
        const form = inputEl.form;
        if (form) form.dispatchEvent(new Event('submit', { cancelable: true }));
      }
    };
    recognition.onerror = (event) => console.error('Speech recognition error:', event.error);
    recognition.start();
  }

  // Speaks the provided text using the browser's text-to-speech engine.
  // One sentence explanation: converts a string answer into audible speech.
  function speak(text) {
    if (!window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(String(text));
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    window.speechSynthesis.speak(utterance);
  }

  window.voice = { startListening, speak };
})();
