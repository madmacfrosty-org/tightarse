# Running the end-to-end suite

Stage 5 of [the test strategy](test-strategy.md): a real browser against a
deployed environment. See [#169](https://github.com/madmacfrosty-org/tightarse/issues/169).

```sh
cd <repo root>                          # -w only resolves workspaces from here
npm run e2e:install -w @tightarse/e2e   # chromium, once
export E2E_EMAIL=<the dev test identity>
export E2E_PASSWORD=<its password>
npm run test:e2e -w @tightarse/e2e
```

## Dev, and only dev

`playwright.config.ts` refuses any base URL that is not dev's, and the browser
is confined to the origins that deployment declares in its own `/config.json` —
itself, its API, and Cognito's hosted UI. Everything else is aborted, and one of
the tests asserts that nothing was.

Prod's URL sits in the same config file as dev's, which is why this is enforced
rather than written down.

## The test identity

A Cognito user in dev's pool with a password, plus a membership row granting it a
tenant. Both are needed: the pre-token trigger issues `custom:tenant` from the
membership record, and the API rejects a token without one — which presents as a
broken dashboard rather than a missing grant.

Never the household's own account. A failure writes a screenshot, and a
screenshot is a picture of whatever was on screen.

## One worker

Deliberate. Dev's Lambda concurrency limit is 5 and one dashboard load makes
exactly five calls, so a second worker throttles the account and API Gateway
answers 503 with no body. That reads as a broken API: `Errors` stays at zero and
the function logs nothing, because it was never invoked.

If the suite starts failing with bodyless 5xx, check `Throttles` before
suspecting the application.

## What a failure leaves behind

Traces and screenshots under `e2e/test-results/`, and the signed-in session under
`e2e/.auth/`. All gitignored, and they must stay that way — the first run is what
creates them and they look like ordinary test output.

`e2e/test-results/*/error-context.md` holds the page as Playwright saw it, which
is usually faster than opening the trace.
