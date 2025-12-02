// /src/lib/apiClient.js
export async function apiFetch(path, options = {}) {
  const baseUrl = import.meta.env.VITE_API_BASE_URL.replace(/\/$/, "");
  const url = `${baseUrl}${path}`;

  try {
    const response = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });

    if (!response.ok) {
      const text = await response.text();

      window.backendDebug = {
        type: "http-error",
        timestamp: new Date().toISOString(),
        url,
        method: options.method || "GET",
        status: response.status,
        statusText: response.statusText,
        body: text,
      };

      console.error("[Backend HTTP Error]", window.backendDebug);
    }

    return response;
  } catch (err) {
    window.backendDebug = {
      type: "network-crash",
      timestamp: new Date().toISOString(),
      url,
      method: options.method || "GET",
      error: err.message,
    };
    console.error("[Backend Crash]", window.backendDebug);
    throw err;
  }
}
