import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // The dev-server half of the same problem as `commonjsOptions` below.
    //
    // The workspace packages build to CommonJS. Vite excludes *linked* packages
    // from dependency pre-bundling by default, so in dev it served
    // `packages/api-contract/dist/index.js` verbatim — `"use strict"; exports.pathFor = …`
    // straight to a browser that has no `exports`. That throws on the first
    // line and renders a blank page with the error only in the console.
    //
    // Listing it here makes Vite pre-bundle it to ESM, the same conversion
    // rollup does for the production build. Both are needed: `build` and `dev`
    // are separate pipelines and fixing one leaves the other broken.
    include: ["@tightarse/api-contract"],
  },
  build: {
    commonjsOptions: {
      // The workspace packages build to CommonJS, and rollup only converts
      // CommonJS it finds under node_modules. These resolve through a symlink
      // to `packages/`, so without this their named exports are invisible and
      // the build fails with "pathFor is not exported" — while the types
      // resolve and every test passes, because vitest reads the source.
      //
      // It only started mattering when the dashboard imported its first *value*
      // from a workspace package rather than only types, which erase.
      include: [/node_modules/, /packages\//],
    },
  },
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
