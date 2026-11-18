import { defineConfig, defaultClientConditions } from "vite";
import react from "@vitejs/plugin-react";

const backend = process.env.AICMS_URL ?? "http://127.0.0.1:4321";

// Studio ships prebuilt inside the aicms package (dist/studio), served at /studio/.
export default defineConfig({
  base: "/studio/",
  plugins: [react()],
  resolve: { conditions: ["source", ...defaultClientConditions] },
  build: { outDir: "../dist/studio", emptyOutDir: true, chunkSizeWarningLimit: 700 },
  server: {
    proxy: {
      "/api": backend,
      "/studio/login": backend,
      "/studio/logout": backend,
    },
  },
});
