import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback only. The dev API it talks to has no authentication.
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
