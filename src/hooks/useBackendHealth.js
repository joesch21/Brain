// /src/hooks/useBackendHealth.js
import { useEffect } from "react";

export default function useBackendHealth() {
  useEffect(() => {
    const checkHealth = async () => {
      const baseUrl = import.meta.env.VITE_API_BASE_URL.replace(/\/$/, "");

      try {
        const res = await fetch(`${baseUrl}/api/status`);
        if (!res.ok) {
          window.backendDebug = {
            type: "status-error",
            timestamp: new Date().toISOString(),
            status: res.status,
            statusText: res.statusText,
          };
        }
      } catch (err) {
        window.backendDebug = {
          type: "status-offline",
          timestamp: new Date().toISOString(),
          error: err.message,
        };
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, []);
}
