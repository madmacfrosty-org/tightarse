import { useEffect, useState } from "react";
import { AccountsResponse, pathFor } from "@tightarse/api-contract";
import { Categorise } from "./Categorise";
import type { Api } from "./ports";
import { rangeFor } from "./positions";

/**
 * Keeping the categories accurate: the bookkeeper's page.
 *
 * One request of its own, and it is not about categories at all — it is the
 * window. Searching is server-side, so the range decides which transactions are
 * offered, and the honest range is everything every account covers rather than
 * an arbitrary year. `completeFrom` says what that is, and only `/accounts`
 * knows it.
 *
 * Pre-window transactions are real — they are simply from accounts that existed
 * while a later one did not — and a rule made here still reaches them.
 */
export function Categories({ api }: { api: Api }) {
  const [completeFrom, setCompleteFrom] = useState<string | null>(null);

  useEffect(() => {
    // Deliberately not surfaced as an error. Without it the page falls back to
    // a year and still works, which is a narrower search rather than a broken
    // screen — and the search itself reports its own failures.
    api
      .get(AccountsResponse, pathFor("/accounts"))
      .then((a) => setCompleteFrom(a.completeFrom ?? null))
      .catch(() => setCompleteFrom(null));
  }, [api]);

  return (
    <Categorise
      api={api}
      from={completeFrom ?? rangeFor(365, new Date()).from}
      to={rangeFor(0, new Date()).to}
    />
  );
}
