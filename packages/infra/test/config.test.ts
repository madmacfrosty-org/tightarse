import { describe, it, expect } from "vitest";
import * as cdk from "aws-cdk-lib";
import { connectRedirectUri, envSettings, secretPrefix } from "../lib/config.js";
import { templates } from "./harness.js";

/**
 * Which environment a deploy is for.
 *
 * The one input that decides whether a stack retains its data or destroys it, so
 * a wrong answer here is not a wrong answer anywhere else.
 */

const appWith = (env?: string) =>
  new cdk.App({ context: env === undefined ? {} : { env } });

describe("choosing an environment", () => {
  it("defaults to dev, so destructive settings are never the accident", () => {
    // You have to ask for prod. A default of prod would mean a forgotten flag
    // deployed RETAIN and deletion protection over a throwaway stack, and the
    // mistake would only surface when something needed deleting.
    expect(envSettings(appWith()).name).toBe("dev");
    expect(envSettings(appWith()).removalPolicy).toBe(cdk.RemovalPolicy.DESTROY);
  });

  it("gives prod the settings that keep data", () => {
    const prod = envSettings(appWith("prod"));
    expect(prod.removalPolicy).toBe(cdk.RemovalPolicy.RETAIN);
    expect(prod.deletionProtection).toBe(true);
    expect(prod.pointInTimeRecovery).toBe(true);
    expect(prod.autoDeleteObjects).toBe(false);
  });

  it("refuses an environment it does not know rather than falling back to dev", () => {
    // A typo — `-c env=prd` — must not deploy dev's settings under a name that
    // reads like production. Silently defaulting is how a stack ends up
    // destroyable because of a missing letter.
    expect(() => envSettings(appWith("prd"))).toThrow(/Unknown env/);
    expect(() => envSettings(appWith("production"))).toThrow(/expected "dev" or "prod"/);
  });

  it("keeps each environment's secrets under its own prefix", () => {
    // One Secrets Manager per account today, but the prefix is what would stop a
    // shared one handing prod's refresh tokens to dev.
    expect(secretPrefix("dev")).toBe("tightarse/dev/truelayer");
    expect(secretPrefix("prod")).toBe("tightarse/prod/truelayer");
  });
});

describe("where the bank sends the browser back", () => {
  it("appends the path to whatever site is configured", () => {
    // Derived rather than configured separately: the two must agree, and a second
    // field is a second thing to get wrong. It must also match what is registered
    // with TrueLayer exactly — the provider refuses anything else.
    expect(connectRedirectUri(envSettings(appWith("prod")))).toBe(
      "https://tightarse.madmacfrosty.co.uk/connected",
    );
  });
});

describe("an environment that has no site yet", () => {
  // Reachable, and it used to be prod. A new environment is in this state until
  // its domain is chosen, and until then nothing may claim a callback URL that
  // does not resolve — the bank would reject the authorisation, which costs the
  // consent it was spent on.
  const noSite = templates({}, { siteUrl: undefined });

  it("sends the bank to the local dev server", () => {
    expect(connectRedirectUri({ ...envSettings(appWith()), siteUrl: undefined })).toBe(
      "http://localhost:5173/connected",
    );
  });

  it("claims no https callback on the user pool", () => {
    // The list is built by spreading siteUrl when there is one. With none, it must
    // be absent rather than empty-string or localhost-with-https.
    const clients = noSite.data.findResources("AWS::Cognito::UserPoolClient");
    const urls = Object.values(clients).flatMap((c: any) => c.Properties?.CallbackURLs ?? []);
    expect(urls.some((u: string) => u.startsWith("https://"))).toBe(false);
  });

  it("claims no https callback on the API's pool either", () => {
    const clients = noSite.api.findResources("AWS::Cognito::UserPoolClient");
    const urls = Object.values(clients).flatMap((c: any) => c.Properties?.CallbackURLs ?? []);
    expect(urls.some((u: string) => u.startsWith("https://"))).toBe(false);
  });
});
