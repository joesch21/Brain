// /src/hooks/useBackendHealth.js
import { useEffect } from "react";
import { OPS_API_BASE } from "../lib/opsApiBase";

export default function useBackendHealth() {
  useEffect(() => {
    const checkHealth = async () => {
      const baseUrl = OPS_API_BASE;

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
