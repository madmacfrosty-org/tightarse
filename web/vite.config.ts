import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
