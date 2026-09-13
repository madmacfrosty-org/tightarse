# 3. One TrueLayer credential, and it belongs to prod alone

Status: accepted
Date: 2026-09-13
Issue: #71

## Context

`tightarse/prod/truelayer/client-secret` and `tightarse/dev/truelayer/client-secret`
held the same client id and secret. It was copied into prod by hand on 23 August
2026 during the cutover, because a refresh needs the client credential and prod's
was still the empty placeholder.

ADR-less at the time, but deliberate: #43 chose to reuse the registration so prod
would inherit the existing bank connections and nobody would have to re-authorise
three banks. The cost was stated and accepted — "the credential lives in both
accounts during the changeover, which is some of what a separate prod account is
for".

The changeover ended. Prod holds the connections, refreshes them daily, and is
the only deployment permitted to: `syncEnabled` is false in dev precisely because
a dev refresh would spend a token prod is holding and kill the connection days
later. What remained was the cost without the reason for it — two accounts
holding one credential to a household's live bank data, and nothing in the tree
recording that they did.

Dev is the account built to be thrown away: `RemovalPolicy.DESTROY`, no deletion
protection, `autoDeleteObjects`, no point-in-time recovery. A live credential to
someone's bank data was the one thing in it that did not fit that description.

## Decision

Dev holds no TrueLayer credential. Its secret is overwritten with the empty
placeholder — `{"clientId":"","clientSecret":""}`, the value `FoundationStack`
creates on a fresh deploy — and the deployment no longer asks for one:
`DailySync` is disabled wherever `syncEnabled` is false, so dev's schedule does
not fire, does not start the sync state machine, and does not read the credential
it no longer has.

Cleared rather than deleted, and the distinction is mechanical rather than
cautious. The secret is a CDK resource in `FoundationStack` carrying
`RemovalPolicy.RETAIN` — "retained even in dev, that is the entire point of this
stack". Deleting it from the account would leave CloudFormation tracking a
resource that is not there, and the fix for that is removing the construct, which
is a change to the one stack whose purpose is keeping things. Emptying the value
reaches the same end state for anyone holding it.

The credential is not rotated. Rotation invalidates the value both accounts hold,
so it must be done in one sitting with prod's replacement ready, and it was
judged not worth that window for a value that has not left two accounts we
control.

Where dev needs the connect flow exercised, that is what `TL_ENV=sandbox` and a
sandbox credential are for — a flow tested against something that cannot spend a
real consent.

## Consequences

**The isolation is checkable from dev alone.** "There is no credential in that
account" is a fact about the account rather than a claim about TrueLayer's
configuration, and reading the secret answers it without reference to anything
else.

**It does not undo the exposure.** Deleting the copy stops the credential being
in a throwaway account from now on; it does nothing about the three weeks it was.
Anything that read it before today still holds a working credential, and only
rotation would change that. This ADR accepts that risk rather than pretending the
deletion removes it — if there is ever reason to think the value leaked, the
answer is rotation and nothing here helps.

**Dev cannot sync, and now cannot try.** `SYNC_ENABLED` already stopped the work;
the schedule firing anyway was how the credential kept being read. The two
together mean dev asks for nothing.

**Prod is unchanged.** `syncEnabled` is true there, so the rule stays enabled and
the synthesised template does not move. A change to a shared stack that alters
one environment and not the other is worth verifying rather than assuming, and
was.
