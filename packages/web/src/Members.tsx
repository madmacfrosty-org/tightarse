import { useCallback, useEffect, useState } from "react";
import {
  AddMemberRequest,
  MemberView,
  MembersResponse,
  RemoveMemberResponse,
  pathFor,
} from "@tightarse/api-contract";
import type { Api } from "./ports";

/**
 * Who can see the household.
 *
 * The most consequential screen in the application, and the copy says so. A
 * row here is the whole authorisation model: whoever holds that address at
 * the identity provider sees every transaction, balance and bank. There is no
 * second factor behind it and no per-page permission.
 *
 * Only an administrator sees this at all. The API refuses everyone else, so
 * a member reading it gets the refusal rather than an empty list — which is
 * the honest answer: "you may not see this" and "nobody has access" are very
 * different things and must not look alike.
 */

const ROLES = [
  {
    value: "admin" as const,
    label: "Administrator",
    does: "Connect banks, suspend and remove them, change settings, and change who has access.",
  },
  {
    value: "member" as const,
    label: "Member",
    does: "See everything and categorise spending. Cannot change banks or who has access.",
  },
];

export function Members({ api }: { api: Api }) {
  const [members, setMembers] = useState<MemberView[] | null>(null);
  // Two errors, because they mean different things. Failing to read means
  // there is no list to show; failing to add means the list is still true and
  // one action did not happen.
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  const read = useCallback(
    () =>
      api
        .get(MembersResponse, pathFor("/members"))
        .then((r) => setMembers(r.members))
        .catch((e: unknown) =>
          setReadError(
            e instanceof Error ? e.message : "Could not read who has access",
          ),
        ),
    [api],
  );

  useEffect(() => {
    void read();
  }, [read]);

  const add = async () => {
    const parsed = AddMemberRequest.safeParse({ email: email.trim(), role });
    if (!parsed.success) {
      // Checked here as well as at the API, because the round trip for a
      // missing @ is a worse way to learn it.
      setActionError("That does not look like an email address.");
      return;
    }

    setBusy("add");
    setActionError(null);
    try {
      await api.post(MemberView, pathFor("/members"), parsed.data);
      setEmail("");
      await read();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Could not give them access");
    } finally {
      setBusy(null);
    }
  };

  const remove = async (m: MemberView) => {
    // Asked, because it cannot be undone from here: they stop getting a
    // household claim the next time they sign in, and only an administrator
    // can put it back.
    if (
      !window.confirm(
        `Remove ${m.email}?\n\nThey will lose access to this household the next time they sign in.`,
      )
    ) {
      return;
    }

    setBusy(m.email);
    setActionError(null);
    try {
      await api.post(RemoveMemberResponse, pathFor("/members/remove"), { email: m.email });
      await read();
    } catch (e: unknown) {
      setActionError(e instanceof Error ? e.message : "Could not remove them");
    } finally {
      setBusy(null);
    }
  };

  if (readError) {
    return (
      <div className="card">
        <h2>Who can see this household</h2>
        <p className="note">{readError}</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Who can see this household</h2>
      <p className="note">
        Anyone here sees every account, balance and transaction. Access is by email
        address — whoever signs in with it gets in.
      </p>

      {actionError !== null && (
        <p className="error" role="alert" style={{ padding: "12px 0 0", fontSize: 13 }}>
          {actionError}
        </p>
      )}

      {members === null && <p className="note">Reading…</p>}

      {members !== null && (
        <table>
          <thead>
            <tr>
              <th>Email</th>
              <th>Can do</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...members]
              // Administrators first, then alphabetically: the question being
              // asked is usually "who can change things".
              .sort((a, b) =>
                a.role === b.role ? a.email.localeCompare(b.email) : a.role === "admin" ? -1 : 1,
              )
              .map((m) => (
                <tr key={m.email}>
                  <td>{m.email}</td>
                  <td className="subtle">
                    {ROLES.find((r) => r.value === m.role)?.label ?? m.role}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy !== null}
                      onClick={() => void remove(m)}
                      title="Take away their access to this household."
                    >
                      {busy === m.email ? "Removing…" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      <h3>Give somebody access</h3>
      <div className="provider-row" style={{ gap: 8, alignItems: "center" }}>
        <input
          aria-label="Email address"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="them@example.com"
          style={{ flex: 1, minWidth: 0 }}
        />
        <select
          aria-label="What they can do"
          value={role}
          onChange={(e) => setRole(e.target.value as "admin" | "member")}
        >
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <button type="button" className="provider" disabled={busy !== null} onClick={() => void add()}>
          {busy === "add" ? "Adding…" : "Give access"}
        </button>
      </div>
      <p className="note">{ROLES.find((r) => r.value === role)?.does}</p>
    </div>
  );
}
