import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  // Dev-only: route /api/* calls from Vite (5173) to Brain (5055)
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5055",
        changeOrigin: true,
        secure: false,
      },
    },
  },

  // Build output (keep as-is)
  build: {
    outDir: "frontend_dist",
  },
});
