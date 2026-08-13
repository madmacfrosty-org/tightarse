import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * jsdom keeps one document for the whole file, so a component left mounted by
 * one test is still in the DOM for the next — which turns a passing suite into
 * a misleading one the moment two tests query for the same text.
 */
afterEach(() => {
  cleanup();
  // Guarded: this jsdom build does not supply a usable localStorage, and an
  // unguarded call fails every test in the file for a reason unrelated to any
  // of them.
  if (typeof sessionStorage?.clear === "function") sessionStorage.clear();
  if (typeof localStorage?.clear === "function") localStorage.clear();
  window.history.replaceState({}, "", "/");
});
