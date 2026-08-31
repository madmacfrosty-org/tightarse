import { describe, it, expect, vi } from "vitest";
import { AwsSecrets } from "../src/secrets.js";

const notFound = () => Object.assign(new Error("nope"), { name: "ResourceNotFoundException" });
const client = (send: (cmd: any) => Promise<unknown>) => ({ send: vi.fn(send) }) as any;

describe("reading a secret", () => {
  it("returns the value", async () => {
    const s = new AwsSecrets({ client: client(async () => ({ SecretString: "shh" })) });
    expect(await s.get("n")).toBe("shh");
  });

  it("returns undefined when it does not exist, rather than throwing", async () => {
    // A connection with no stored token yet is an ordinary state during the
    // connect flow, not an error the caller should have to catch.
    const s = new AwsSecrets({ client: client(async () => { throw notFound(); }) });
    expect(await s.get("n")).toBeUndefined();
  });

  it("rethrows anything else", async () => {
    // Access denied must not look like absence. Treating it as "no token yet"
    // would send the connect flow round again and burn a consent.
    const s = new AwsSecrets({
      client: client(async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      }),
    });
    await expect(s.get("n")).rejects.toThrow(/denied/);
  });
});

describe("writing a secret", () => {
  it("puts into an existing secret", async () => {
    const cmds: string[] = [];
    const s = new AwsSecrets({
      client: client(async (cmd) => {
        cmds.push(cmd.constructor.name);
        return {};
      }),
    });
    await s.set("n", "v");
    expect(cmds).toEqual(["PutSecretValueCommand"]);
  });

  it("creates it when it does not exist yet", async () => {
    // Callers storing a refreshed token do not know whether this connection has
    // been stored before, and should not have to.
    const cmds: string[] = [];
    const s = new AwsSecrets({
      client: client(async (cmd) => {
        cmds.push(cmd.constructor.name);
        if (cmd.constructor.name === "PutSecretValueCommand") throw notFound();
        return {};
      }),
    });
    await s.set("n", "v");
    expect(cmds).toEqual(["PutSecretValueCommand", "CreateSecretCommand"]);
  });

  it("does not fall back to create on an unrelated failure", async () => {
    // Creating a secret because a write was denied would replace a refresh token
    // with a new empty one, which costs a consent to recover.
    const s = new AwsSecrets({
      client: client(async () => {
        throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
      }),
    });
    await expect(s.set("n", "v")).rejects.toThrow(/denied/);
  });
});

describe("describing and tagging on write", () => {
  it("carries the description and tags when it creates the secret", async () => {
    // A secret holding five years of history access, findable by nobody, is
    // worse than an inconvenience: cost attribution and access review both work
    // off the tag.
    const sent: any[] = [];
    const s = new AwsSecrets({
      client: client(async (cmd) => {
        sent.push(cmd);
        if (sent.length === 1) throw notFound();
        return {};
      }),
    });
    await s.set("n", "v", { description: "why this exists", tags: { tenant: "frost" } });
    expect(sent[1].input).toMatchObject({
      Name: "n",
      Description: "why this exists",
      Tags: [{ Key: "tenant", Value: "frost" }],
    });
  });

  it("tags an existing secret with a separate call, because PutSecretValue drops them", async () => {
    // The bug this catches: passing Tags to PutSecretValue is silently ignored,
    // so a secret created before tagging existed would stay untagged for ever
    // while the caller believed it had asked.
    const sent: any[] = [];
    const s = new AwsSecrets({ client: client(async (cmd) => { sent.push(cmd); return {}; }) });
    await s.set("n", "v", { tags: { tenant: "frost" } });
    expect(sent).toHaveLength(2);
    expect(sent[1].input).toMatchObject({ SecretId: "n", Tags: [{ Key: "tenant", Value: "frost" }] });
  });

  it("makes no extra call when there is nothing to tag", async () => {
    const sent: any[] = [];
    const s = new AwsSecrets({ client: client(async (cmd) => { sent.push(cmd); return {}; }) });
    await s.set("n", "v");
    expect(sent).toHaveLength(1);
  });

  it("omits absent fields rather than sending them empty", async () => {
    // An explicit undefined Description is not the same as no Description, and
    // the API rejects some empty values outright.
    const sent: any[] = [];
    const s = new AwsSecrets({
      client: client(async (cmd) => {
        sent.push(cmd);
        if (sent.length === 1) throw notFound();
        return {};
      }),
    });
    await s.set("n", "v");
    expect(sent[1].input).not.toHaveProperty("Description");
    expect(sent[1].input).not.toHaveProperty("Tags");
  });
});

describe("listing by prefix", () => {
  it("filters server-side, so one household does not pay to list every secret", async () => {
    const sent: any[] = [];
    const s = new AwsSecrets({
      client: client(async (cmd) => {
        sent.push(cmd);
        return { SecretList: [{ Name: "p/a" }] };
      }),
    });
    await s.list("p/");
    expect(sent[0].input).toMatchObject({ Filters: [{ Key: "name", Values: ["p/"] }] });
  });

  it("follows pagination, so a household is never partly synced", async () => {
    // Stopping at the first page would silently skip connections, and the
    // accounts behind them would go stale with nothing reporting it.
    const pages = [
      { SecretList: [{ Name: "p/a" }], NextToken: "more" },
      { SecretList: [{ Name: "p/b" }] },
    ];
    const tokens: Array<string | undefined> = [];
    let i = 0;
    const s = new AwsSecrets({
      client: client(async (cmd) => {
        tokens.push(cmd.input.NextToken);
        return pages[i++]!;
      }),
    });
    expect(await s.list("p/")).toEqual(["p/a", "p/b"]);
    expect(tokens).toEqual([undefined, "more"]);
  });

  it("skips an entry with no name rather than failing the list", async () => {
    const s = new AwsSecrets({
      client: client(async () => ({ SecretList: [{}, { Name: "p/b" }] })),
    });
    expect(await s.list("p/")).toEqual(["p/b"]);
  });

  it("returns nothing when the account has no matching secrets", async () => {
    // SecretList is absent rather than empty on some responses, and treating
    // that as a failure would break a household mid-onboarding.
    const s = new AwsSecrets({ client: client(async () => ({})) });
    expect(await s.list("p/")).toEqual([]);
  });
});

describe("construction", () => {
  it("builds its own client when not given one", () => {
    expect(() => new AwsSecrets({ region: "eu-west-1" })).not.toThrow();
    expect(() => new AwsSecrets()).not.toThrow();
  });
});
