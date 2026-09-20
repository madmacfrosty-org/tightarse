# Routing

Which pages exist, what each is for, and how you move between them.

To be executed by `tests/routing.spec.ts`, which does not exist yet. Each
scenario names
the job it serves, from [`docs/product/jobs.md`](../../docs/product/jobs.md),
and says whether a test covers it today.

Nothing here is built. Every scenario is currently **Covered: no**, and the
application serves one scrolling page.

## Starting state

Every scenario assumes a signed-in session unless it says otherwise, and a
ledger with at least one account and some settled transactions.

Unknown paths already reach the application rather than a 404: CloudFront
serves `index.html` for 403 and 404 alike, because for a single-page
application an unknown path is a route, not a missing file.

## The pages

`/` carries the balance over time as well as the position. A number on its own
does not say whether it is good news, and seeing the line is part of the glance
rather than a deeper question about it.

It is three months, ending at a date the page is pinned to. The pin defaults to
today and is read from `?at=`; there is no control for it, deliberately. A
glance answers without asking anything first, and "which window?" is a question.
The parameter exists so the origin can move later, and so a test can assert on a
fixed ledger rather than on whatever today happens to contain.

`at` is not `asAt`. This moves the window; `asAt` in the reporting means what we
believed at a moment, including which categorisations had been recorded by then.
Two different questions that would be one word if nobody said otherwise.

| Path | For | Mode | Jobs |
| --- | --- | --- | --- |
| `/` | Where do we stand, now, and how it has moved | glance | J-1, J-2 |
| `/spending` | Where the money went, and what changed | review | J-3, J-4, J-5, J-6 |
| `/categories` | Keeping categories accurate | — | J-7, J-8 |
| `/operations` | Connections, consents, and does the ledger match | — | J-9, J-10, J-11 |
| `/connected` | Returning from a bank authorisation | — | J-11 |

Operator work has a page, and also reaches out from it. The rule is **urgent
comes to you, routine you go to**:

- **J-9, keeping the feed alive.** A consent close to lapsing appears on `/`,
  above the figures, because it has a deadline and they do not. Nobody goes
  looking for an expiry warning. The full list of connections and how long each
  has left lives on `/operations`, for when you want to check rather than be
  told.
- **J-10, does the ledger match the bank.** Triggered by doubting a figure, so
  it can be reached from the figure as well — but it is a tool, and
  `/operations` is where a tool belongs.
- **J-11, adding a bank.** Entered from `/operations`, and it ends at
  `/connected`.

`/operations` is also where the settings in #151 would go: consent thresholds
and who has access are neither money nor categories.

---

## 1. Signing in lands on the glance

Job: **J-1** — know where we stand · Covered: **no**

1. Visit the site signed out.
2. Sign in.

**Expected:** the browser finishes at `/`, showing the glance.

**Succeeds when** the first thing after signing in answers "where do we stand".

**Fails when** it lands anywhere requiring a decision about what to look at.
The glance is what the household opens the application for; anything else is a
step in the way of it.

---

## 2. Each page shows only its own work

Job: **J-1**, **J-3**, **J-7**, **J-10** · Covered: **no**

1. Visit `/`.
2. Visit `/spending`.
3. Visit `/categories`.
4. Visit `/operations`.

**Expected:** each shows what its row in the table above says and nothing from
the others. `/` has no rule authoring on it; `/categories` has no net position;
`/operations` has no spending on it.

**Succeeds when** a page can be described in one sentence.

**Fails when** any page grows a section belonging to another. That is how the
single scrolling page happened — each feature added below the last, until a
glance and a twenty-minute sitting shared one surface.

---

## 3. Every page can reach every other

Job: **J-1**, **J-3**, **J-7** · Covered: **no**

1. Visit `/`.
2. Navigate to `/spending`, then `/categories`, then `/operations`, then back
   to `/`.

**Expected:** navigation is present on all four, names the destination, and
marks which one you are on. `/operations` is reachable without typing an
address, and is not given the same prominence as the three you use weekly.

**Succeeds when** moving between them needs no typed URL and no back button.

**Fails when** a page is reachable only by editing the address bar.

---

## 4. A page can be linked to, and comes back the same

Job: **J-3** — notice a cost that has crept up · Covered: **no**

1. Visit `/spending` and choose a range other than the default.
2. Copy the address.
3. Open it again in a new tab.

**Expected:** the range is in the address, and reopening it shows the same
period rather than the default.

**Succeeds when** the address describes what is on screen.

**Fails when** the address is the same whatever you are looking at. A review
that cannot be returned to has to be reconstructed each time, which is most of
the cost of doing one.

---

## 5. An unknown path is not a dead end

Covered: **no**

1. Visit a path that is not one of the pages.

**Expected:** the application loads and says the page does not exist, offering
the way back. It does not show a blank screen, and does not silently render the
glance as though the address had been correct.

**Succeeds when** a mistyped address is recoverable without retyping the site.

**Fails when** the browser shows nothing, or shows a page other than the one
asked for with no indication.

---

## 6. Returning from a bank authorisation still works

Job: **J-11** — add a bank without losing history · Covered: **no**

1. Begin a bank connection.
2. Complete the provider's consent screen.

**Expected:** the browser returns to `/connected`, the code is exchanged, and
the first sync starts.

**Succeeds when** the connection completes and history arrives.

**Fails when** the callback path stops being handled. This is the one route
where a mistake is unrecoverable: roughly an hour after authorisation only
ninety days of history remain available, for ever. A routing change that drops
`/connected` costs years that no amount of retrying gets back.

---

## 7. A deep link while signed out arrives signed in

Covered: **no**

1. Sign out.
2. Visit `/spending` directly.
3. Sign in.

**Expected:** the browser finishes at `/spending`.

**Succeeds when** the requested page is what you get.

**Fails when** you land at `/` having asked for something else — which is the
current behaviour, because the provider's redirect target is the site root. The
requested path has to survive the round trip through the identity provider, and
nothing does that today.
