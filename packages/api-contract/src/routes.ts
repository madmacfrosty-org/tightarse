/**
 * The API's routes, as data.
 *
 * The response *shapes* have had one definition since #24, but the paths that
 * serve them were still written out separately in three places: the API Gateway
 * route list, the handler's matcher, and the dashboard's fetch calls. A
 * generated OpenAPI document assembled from a hand-written path list would put
 * the drift back in a new file — so the paths live here too, and everything
 * else is derived.
 */

import { z } from "zod";
import {
  AccountsResponse,
  BacklogResponse,
  ProposalRequest,
  ProposalResponse,
  BalancesResponse,
  IsoDate,
  SummaryResponse,
  TransactionsResponse,
} from "./index.js";

/**
 * The version prefix every path carries.
 *
 * A path prefix rather than a header: it is visible in an access log, in a
 * CloudWatch metric dimension and in a `curl` someone pastes into a bug report,
 * and none of those show a header without being asked. See #27.
 */
export const API_VERSION = "v1";

/**
 * What `v1` promises, and it is deliberately narrow.
 *
 * A browser reloads and moves with the API. An installed app does not: once a
 * build is on a phone, the shape it understands has to keep working for as long
 * as someone runs it — including someone who has stopped taking updates. So the
 * promise is written for the client that cannot be fixed remotely.
 *
 * **Within `v1` the API may:**
 * - add a new field to a response
 * - add a new optional query parameter
 * - add a new route
 *
 * **Within `v1` the API may not:**
 * - remove or rename a field
 * - change a field's type, or its units
 * - make an optional field required, or a required field optional
 * - change what an existing field means
 *
 * A client must therefore ignore fields it does not recognise rather than
 * failing on them. That is the one obligation this promise puts on the client
 * side, and it is what makes "add a field" a safe change rather than a breaking
 * one.
 *
 * Anything in the second list is a `v2`. The snapshot test exists to make that
 * decision visible in a diff instead of discovering it from a client that has
 * already shipped.
 */
export const COMPATIBILITY_PROMISE =
  "Within a major version the API may add fields, optional parameters and routes. " +
  "It may not remove or rename a field, change its type or units, change whether it is " +
  "required, or change what it means. Clients must ignore unrecognised fields.";

/** A query parameter, described once and rendered into the document. */
export interface QueryParam {
  readonly name: string;
  readonly required: boolean;
  readonly schema: z.ZodTypeAny;
  readonly description: string;
}

export interface Route {
  readonly method: "get" | "post";
  /** Path *without* the version prefix; `pathFor` adds it. */
  readonly path: string;
  readonly summary: string;
  readonly description: string;
  readonly query: readonly QueryParam[];
  /**
   * The schema of a request body, and the name it gets in `components`.
   *
   * Absent on a GET, which has no body to describe. Present on a POST, where a
   * generated client needs the request struct as much as the response one — an
   * endpoint documented with only its output leaves the caller guessing at the
   * input, which is the half that can be got wrong silently.
   */
  readonly request?: { readonly name: string; readonly schema: z.ZodTypeAny };
  /** The schema of a 200 response, and the name it gets in `components`. */
  readonly response: { readonly name: string; readonly schema: z.ZodTypeAny };
}

/**
 * Both ends inclusive, and both required.
 *
 * Defaulting a missing range would make "no range" mean whatever the server
 * felt like that day, and a client cannot tell a defaulted answer from an
 * answer to the question it asked.
 */
const range: readonly QueryParam[] = [
  { name: "from", required: true, schema: IsoDate, description: "First day included in the range" },
  { name: "to", required: true, schema: IsoDate, description: "Last day included in the range" },
];

/**
 * Note what is absent: `limit`. The API never honoured one, and a limit without
 * a cursor truncates rather than paginates — it hides rows with no way to ask
 * for the next ones. Publishing it here would have promised a capability
 * nothing implements to a client that cannot read the handler. See #28.
 */
export const ROUTES: readonly Route[] = [
  {
    method: "get",
    path: "/summary",
    summary: "Totals for a date range",
    description:
      "Spending and income over the range, split by category and by month, with internal transfers netted out.",
    query: range,
    // Named `Summary`, not `SummaryResponse`: the response *is* a Summary, and
    // a second name for the same shape would put two identical components in
    // the document for a client generator to turn into two structs.
    response: { name: "Summary", schema: SummaryResponse },
  },
  {
    method: "get",
    path: "/transactions",
    summary: "Transactions in a date range",
    description:
      "Every transaction in the range, newest first, with its category where one has been assigned. " +
      "Returns the whole range: there is no pagination, so a wide range is a large response. " +
      "`q` narrows it to descriptions containing that text, case-insensitively and taken literally — " +
      "a search, not a promise about what any rule would match.",
    query: [
      ...range,
      {
        name: "q",
        required: false,
        schema: z.string().min(1),
        description:
          "Narrow to descriptions containing this text. Case-insensitive, and matched literally: " +
          "punctuation is not a pattern. Omit for everything in the range.",
      },
    ],
    response: { name: "TransactionsResponse", schema: TransactionsResponse },
  },
  {
    method: "get",
    path: "/balances",
    summary: "Net position for every day in a range",
    description:
      "One point per day: cash less card debt across the household. The range is clamped to where " +
      "every account has data, because a total drawn earlier silently omits an account — for a card " +
      "that means missing debt, so the figure reads high. The response states the range actually served.",
    query: range,
    response: { name: "BalancesResponse", schema: BalancesResponse },
  },
  {
    method: "get",
    path: "/accounts",
    summary: "The household's accounts and their balances",
    description:
      "One entry per connected account. An account still being described by a sync may be missing " +
      "its identity fields and its isCard flag; absent isCard means NOT YET KNOWN, not false.",
    query: [],
    response: { name: "AccountsResponse", schema: AccountsResponse },
  },
];

/**
 * The categorisation routes.
 *
 * A separate list from `ROUTES` because a different function serves them — that
 * one writes, and the dashboard's stays read-only — not because they are
 * authorised differently. They are not: like everything else here they take a
 * Cognito bearer token and resolve the household from the verified claim, and
 * they appear in the same published document.
 *
 * They were signed with SigV4 so a model outside the account could drive them.
 * That was the wrong trade: a browser holds a bearer token and cannot sign, so
 * the product could not call its own API. The offline path can hold a household
 * token, or use the CLIs that reach the table directly.
 */
export const CATEGORISATION_ROUTES: readonly Route[] = [
  {
    method: "post",
    path: "/categorisation/proposals",
    summary: "Propose a change to the rules, and say what it would do",
    description:
      "Computes what the proposed sets would gain, lose, recategorise, leave alone and be outranked on, " +
      "along with any conflict they would introduce, then writes each set as its next version marked " +
      "`proposed`. `commit` says how far to take it: computing only, writing the proposal, or writing it, " +
      "accepting it and recategorising the range. The prediction is always computed here and never taken " +
      "from the caller.",
    query: [
      ...range,
      {
        name: "commit",
        required: false,
        schema: z.enum(["preview", "propose", "apply"]),
        description:
          "How far to take it. `preview` computes and writes nothing; `propose` writes the version " +
          "awaiting a decision; `apply` writes it, accepts it and recategorises the range. " +
          "Absent means `propose`. One parameter rather than two flags, because a dry run that also " +
          "applies is a combination with no meaning.",
      },
    ],
    request: { name: "ProposalRequest", schema: ProposalRequest },
    response: { name: "ProposalResponse", schema: ProposalResponse },
  },
  {
    method: "get",
    path: "/categorisation/gaps",
    summary: "What the rules do not yet cover",
    description:
      "Every distinct description with what it cost and what the rules currently make of it, amounts " +
      "arriving on a regular beat, and the unmatched backlog — each costliest first. Categories are " +
      "derived by evaluating the rules as they stand, not read from the last application, so a gap " +
      "here is a gap now. Returns the whole range: there is no pagination.",
    query: range,
    response: { name: "BacklogResponse", schema: BacklogResponse },
  },
];

/**
 * The connect flow's paths.
 *
 * Kept out of `ROUTES` and out of the OpenAPI document on purpose: these are a
 * browser redirect chain, not JSON a native client would ever call. Documenting
 * them would invite a client to drive a bank authorisation it cannot complete.
 *
 * They are listed here anyway because they are *paths*, and this file is where
 * paths live — the infrastructure and the dashboard both read them from here,
 * so versioning cannot be applied to one and forgotten on the other.
 *
 * Safe to version, which is worth stating because the equivalent was not true
 * this week: the provider's registered redirect is the dashboard's
 * `/connected`, not an API route, so nothing external is pinned to these. A
 * path registered with a third party cannot be renamed by a deployment — that
 * is the Google redirect URI problem from #36, and it is one to check for
 * before moving any externally-visible path.
 */
export const CONNECT_PATHS = ["/connect/start", "/connect/callback"] as const;

/** The served path for a route, version prefix included. */
export function pathFor(route: Pick<Route, "path"> | string): string {
  const path = typeof route === "string" ? route : route.path;
  return `/${API_VERSION}${path}`;
}
