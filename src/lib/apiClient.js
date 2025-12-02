export async function apiFetch(path, options = {}) {
  const url = `${import.meta.env.VITE_API_BASE_URL}${path}`;

  try {
    const response = await fetch(url, options);

    // Capture non-OK status in a global debug store
    if (!response.ok) {
      window.backendDebug = {
        timestamp: new Date().toISOString(),
        url,
        method: options.method || "GET",
        status: response.status,
        statusText: response.statusText,
        body: await response.text()
      };
      console.error("[Backend Error]", window.backendDebug);
    }

    return response;
  } catch (err) {
    // Capture hard errors
    window.backendDebug = {
      timestamp: new Date().toISOString(),
      url,
      method: options.method || "GET",
      error: err.message
    };
    console.error("[Backend Crash]", window.backendDebug);
    throw err;
  }
}
