import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  test: {
    // The dashboard reads window.location, sessionStorage and fetch. Testing
    // its logic without a DOM would mean testing something else.
    environment: "jsdom",
    globals: false,
    setupFiles: ["src/test-setup.ts"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/test-setup.ts",
        "src/vite-env.d.ts",
        // Mounts the app into the page and nothing else.
        "src/main.tsx",
      ],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        lines: 83.3,
        functions: 58.3,
        branches: 80.1,
        statements: 83.3,
        autoUpdate: false,
      },
    },
  },
});
