import { ConnectBank } from "./Connect";
import { Connections } from "./Connections";
import { Diagnostics } from "./Diagnostics";
import type { Api } from "./ports";

/**
 * Connections, consents, and does the ledger match the bank.
 *
 * Rare work, and about trust rather than money — which is why it is off the
 * household's way. The running-balance check used to sit between the books and
 * the transaction list on the page opened to answer "are we all right", and
 * connecting a bank was offered there too.
 *
 * The connections list loads on arrival, because the question this page answers
 * is "what state is everything in" and a page that made you press something
 * first would not answer it. The reconciliation is still asked for, and
 * starting a connection is still a decision.
 */
export function Operations({ api }: { api: Api }) {
  return (
    <>
      <Connections api={api} />
      <ConnectBank api={api} />
      <Diagnostics api={api} />
    </>
  );
}
