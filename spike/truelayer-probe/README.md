# truelayer-probe

Throwaway. Answers the open questions in #3 (auth flow, enrichment coverage) and
#11 (how deep does First Direct actually go) in a single run, then gets deleted
or folded into `packages/truelayer`.

## Run it

```sh
export TL_CLIENT_ID=...        # from console.truelayer.com — never a file in this repo
export TL_CLIENT_SECRET=...
npm run probe -w @tightarse/truelayer-probe          # sandbox
TL_ENV=live npm run probe -w @tightarse/truelayer-probe   # real bank
```

Register `http://localhost:3000/callback` as a redirect URI in the TrueLayer console.

## Do the sandbox run first

Not caution for its own sake — with First Direct, **deep history is available
once per consent and never again**. Get every wrinkle out of the flow against
the mock bank before spending a real consent.

## Why it does everything in one burst

HSBC and First Direct only serve transactions older than 90 days for roughly
the first hour after consent, using the original access token. The probe
therefore exchanges the code and immediately walks progressively deeper date
ranges — 3, 6, 12, 18, 24, 36 months — recording elapsed seconds since consent
at each step, and stopping at the first failure.

It never refreshes the token. Don't refresh it yourself afterwards if you still
want the history.

## What it writes

`out/findings-*.json` (gitignored), containing **statistics only**:

- which depths succeeded, with HTTP status, error code, and `t+Ns` since consent
- transaction counts and the oldest/newest dates seen
- **field coverage** — the fraction of transactions where each field is
  populated, which is how we find out whether `merchant_name` and
  `transaction_classification` are actually worth anything
- duplicate/distinct transaction id counts, for the pending→settled question

No transaction values, descriptions, merchants or account numbers are ever
written to disk. This repo is public and the discipline starts here.
