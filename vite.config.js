import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Dev-only: route /api/* calls from Vite (5173) to Brain (5055)
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5055",
        changeOrigin: true,
        secure: false,
        ws: false,

        // Harden timeouts (ms)
        timeout: 120000,
        proxyTimeout: 120000,

        // TEMP visibility: prints once per request/response
        configure: (proxy) => {
          proxy.on("proxyReq", (_proxyReq, req) => {
            console.log(`[proxyReq] ${req.method} ${req.url}`);
          });
          proxy.on("proxyRes", (proxyRes, req) => {
            console.log(
              `[proxyRes] ${proxyRes.statusCode} ${req.method} ${req.url}`
            );
          });
          proxy.on("error", (err, req) => {
            console.log(
              `[proxyErr] ${req?.method} ${req?.url} :: ${err?.message}`
            );
          });
        },
      },
    },
  },

  // Build output (keep as-is)
  build: {
    outDir: "frontend_dist",
  },
});
