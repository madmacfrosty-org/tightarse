import { describe, it, expect, vi } from "vitest";
import { AwsSecrets } from "./secrets";

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

describe("construction", () => {
  it("builds its own client when not given one", () => {
    expect(() => new AwsSecrets({ region: "eu-west-1" })).not.toThrow();
    expect(() => new AwsSecrets()).not.toThrow();
  });
});
