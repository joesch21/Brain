// /src/hooks/useBackendHealth.js
import { useEffect } from "react";
import { opsGet } from "../lib/opsApi";
import { apiUrl } from "../lib/apiBase";
import { pushBackendDebugEntry } from "../lib/backendDebug";

export default function useBackendHealth() {
  useEffect(() => {
    const checkHealth = async () => {
      try {
        const res = await opsGet(apiUrl("api/status"));
        if (!res.ok) {
          pushBackendDebugEntry({
            type: "status-error",
            status: res.status,
            statusText: res.statusText,
          });
        }
      } catch (err) {
        pushBackendDebugEntry({
          type: "status-offline",
          error: err.message,
        });
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, []);
}
