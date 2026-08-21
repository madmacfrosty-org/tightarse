import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { autoUpdate } from "@tightarse/vitest-config";
import react from "@vitejs/plugin-react";

/**
 * Refuse to pin thresholds from a run that cannot represent CI.
 *
 * `.env.local` changes which branches are reachable, so a pin taken with it
 * present records a number CI will never meet and fails the build on a machine
 * difference. The cost lands on whoever pushes next, not on whoever pinned.
 */
if (autoUpdate && existsSync(new URL(".env.local", import.meta.url))) {
  throw new Error(
    "Refusing to pin coverage with web/.env.local present: it makes the fetch " +
      "fallback unreachable, so `branches` would be pinned above what CI can " +
      "reach. Move it aside for the pin run:\n\n" +
      "  mv web/.env.local web/.env.local.bak && npm run coverage:pin -w @tightarse/web" +
      " && mv web/.env.local.bak web/.env.local\n",
  );
}


export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  test: {
    // The dashboard reads window.location, sessionStorage and fetch. Testing
    // its logic without a DOM would mean testing something else.
    environment: "jsdom",
    globals: false,
    setupFiles: ["test/test-setup.ts"],
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/vite-env.d.ts",
        // Mounts the app into the page and nothing else.
        "src/main.tsx",
      ],
      reporter: ["text-summary", "json-summary"],
      // Measured with no .env.local, which is CI. loadConfig takes a different
      // branch when build-time values are present, so a threshold pinned on a
      // developer machine fails the build on a machine difference.
      //
      // `autoUpdate` does not know that and will raise `branches` from a local
      // run. Vite inlines import.meta.env at transform time, so with .env.local
      // present the fetch fallback is unreachable and the branch stops counting.
      //
      // This has now broken main twice: 87.19 against the 87.03 CI could reach,
      // and then 90.45 against 90.37. The first time it was met with a comment
      // saying "reproduce CI's number before committing a raise", which is an
      // instruction, and the second time the instruction was walked straight
      // past. So it is a check now — see the guard above the config.
      //
      // Only `branches` moves; the other three are the same either way.
      thresholds: {
        lines: 88.86,
        functions: 69.81,
        branches: 90.37,
        statements: 88.86,
        autoUpdate,
      },
    },
  },
});