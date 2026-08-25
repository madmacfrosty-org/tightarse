/**
 * Mint a short-lived GitHub App installation token, and print it.
 *
 * Without this, `gh` falls back to whatever account `gh auth login` stored — so
 * pull requests opened by automation are authored by a person who did not open
 * them. The app exists precisely so that automation is visibly automation; it
 * had simply never been wired to anything.
 *
 * Usage, minting per command because the token is short-lived and because shell
 * state does not survive between steps:
 *
 *   GH_TOKEN=$(node scripts/gh-app-token.mjs) gh pr create --base main ...
 *
 * The token lasts an hour and carries the installation's permissions, which are
 * narrower than a personal login: contents and pull requests, and whatever else
 * has been granted since. `gh` commands the app has no permission for will fail
 * with a 403 rather than silently acting as a human, which is the intended
 * failure mode.
 *
 * The private key never lives in this repository. It sits outside the tree
 * because this repository is public, and a key committed once is a key
 * compromised for ever.
 *
 * Prints ONLY the token on stdout, so command substitution captures it cleanly.
 * Never echo the result: it is a live credential for an hour.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const APP_ID = process.env["TIGHTARSE_GITHUB_APP_ID"] ?? "4673113";
const KEY_PATH =
  process.env["TIGHTARSE_GITHUB_APP_KEY"] ?? `${homedir()}/.config/tightarse/github-app.pem`;
const OWNER = process.env["TIGHTARSE_GITHUB_OWNER"] ?? "madmacfrosty-org";

const die = (message) => {
  process.stderr.write(`gh-app-token: ${message}\n`);
  process.exit(1);
};

let key;
try {
  key = readFileSync(KEY_PATH, "utf8");
} catch {
  die(`no private key at ${KEY_PATH}. Set TIGHTARSE_GITHUB_APP_KEY, or download one from the app's settings.`);
}

/**
 * A JWT proving we hold the app's private key.
 *
 * Backdated a minute because GitHub rejects a token whose `iat` is in its
 * future, and a laptop clock a few seconds fast is enough to trip that.
 */
function appJwt() {
  const encode = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({ iat: now - 60, exp: now + 540, iss: APP_ID });
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(key, "base64url");
  return `${header}.${payload}.${signature}`;
}

async function api(path, token, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const jwt = appJwt();

// Discovered rather than hardcoded: an installation id is a deployment detail,
// and one written down here would be wrong the first time the app is installed
// somewhere else.
const installations = await api("/app/installations", jwt);
if (installations.status !== 200) {
  die(`could not list installations (${installations.status}): ${installations.body.message ?? ""}`);
}

const installation = installations.body.find((i) => i.account?.login === OWNER);
if (!installation) {
  const seen = installations.body.map((i) => i.account?.login).join(", ") || "none";
  die(`app is not installed on ${OWNER}. Installed on: ${seen}.`);
}

const minted = await api(`/app/installations/${installation.id}/access_tokens`, jwt, { method: "POST" });
if (minted.status !== 201) {
  die(`could not mint a token (${minted.status}): ${minted.body.message ?? ""}`);
}

process.stdout.write(minted.body.token);
