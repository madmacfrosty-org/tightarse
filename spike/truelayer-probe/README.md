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

## If you only have SSH to this machine

The redirect URI stays `http://localhost:3000/callback` either way — it has to
match what is registered with TrueLayer and what we send at token exchange.

**Preferred: forward the port.** From the machine with the browser:

```sh
ssh -L 3000:localhost:3000 agentdev@Mac-mini.lan
```

Then run the probe over that SSH session. Your browser hits `localhost:3000` on
your laptop, the tunnel carries it to the mini, and the callback lands normally.
Nothing to paste, and the timing measurements stay honest.

**Fallback: manual paste.**

```sh
TL_MANUAL=1 npm run probe -w @tightarse/truelayer-probe
```

The probe prints the auth URL and waits on stdin. Authorise in your browser; it
will fail to load the localhost redirect, which is expected — the authorisation
code is in the address bar. Paste the whole URL back.

Be quick about it. The deep-history window starts when you authorise, not when
you paste, so `secondsSinceConsent` in the findings **under-reports** true
elapsed time in this mode. The findings record `captureMode` and
`timingReliable` so this is not forgotten when reading the results.

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
