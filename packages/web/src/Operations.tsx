import { ConnectBank } from "./Connect";
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
 * Nothing here loads on arrival. The reconciliation is asked for, and starting
 * a connection is a decision — so the page that the household never opens costs
 * nothing of the Lambda concurrency the pages they do open are competing for.
 */
export function Operations({ api }: { api: Api }) {
  return (
    <>
      <ConnectBank api={api} />
      <Diagnostics api={api} />
    </>
  );
}
