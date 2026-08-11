import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // /connected is an application route, not a file. Without this the dev server
  // 404s the provider's redirect.
  appType: "spa",
  server: {
    // Loopback only. The dev API it talks to has no authentication.
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:8787", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
