/**
 * The package's surface: the shapes, and the routes that carry them.
 *
 * A thin barrel on purpose. `routes.ts` needs the schemas, and when they lived
 * here it imported the barrel that re-exported it — a cycle CommonJS tolerated
 * by handing out a half-built module, and which ESM refuses outright: `cdk
 * synth` failed with "Cannot access 'IsoDate' before initialization" the moment
 * this package became ESM (ADR 2).
 *
 * Splitting the definitions from the barrel means nothing imports back through
 * it, so there is no cycle to tolerate.
 */
export * from "./schemas.js";

// The paths, the version and the compatibility promise (#26, #27).
//
// Named explicitly rather than `export *`. The reason has changed but not gone:
// when this package was CommonJS a star re-export compiled to `__exportStar`,
// which rollup could not analyse, and the dashboard's bundle failed with
// "pathFor is not exported" while types resolved and every test passed. It is
// ESM now (ADR 2) and a star would analyse, but naming what a package promises
// is worth keeping on its own account.
export {
  API_VERSION,
  COMPATIBILITY_PROMISE,
  CATEGORISATION_ROUTES,
  CONNECT_PATHS,
  ROUTES,
  pathFor,
  type QueryParam,
  type Route,
} from "./routes.js";
