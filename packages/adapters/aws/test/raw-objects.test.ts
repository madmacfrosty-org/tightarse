import { describe, it, expect, vi } from "vitest";
import { S3RawObjects } from "../src/raw-objects.js";

/**
 * The adapter, against a fake S3 client. What is being checked is the
 * translation — that a port call becomes the right command, and that the
 * awkward parts of S3 stay in here rather than leaking to callers.
 */

const client = (send: (cmd: any) => Promise<unknown>) => ({ send: vi.fn(send) }) as any;

describe("reading a raw object", () => {
  it("returns the bytes without interpreting them", async () => {
    // Storage does not know the objects are gzipped JSON. The transform sniffs
    // magic bytes because a manual upload could omit the header, and that
    // decision belongs with the transform.
    const bytes = new Uint8Array([1, 2, 3]);
    const raw = new S3RawObjects({
      bucket: "raw",
      client: client(async () => ({ Body: { transformToByteArray: async () => bytes } })),
    });
    expect(await raw.get("k")).toBe(bytes);
  });

  it("refuses an object with no body rather than returning nothing", async () => {
    // Empty bytes would look to a caller like a provider response containing no
    // rows, which is a real and different thing.
    const raw = new S3RawObjects({ bucket: "raw", client: client(async () => ({})) });
    await expect(raw.get("k")).rejects.toThrow(/no body/);
  });
});

describe("writing a raw object", () => {
  it("sends the key, bytes and bucket it was constructed with", async () => {
    const sent: any[] = [];
    const raw = new S3RawObjects({
      bucket: "raw",
      client: client(async (cmd) => {
        sent.push(cmd.input);
        return {};
      }),
    });
    await raw.put("tenant=frost/x", new Uint8Array([9]));
    expect(sent[0]).toMatchObject({ Bucket: "raw", Key: "tenant=frost/x" });
  });

  it("encodes tags the way S3 wants them, so callers never see that", async () => {
    const sent: any[] = [];
    const raw = new S3RawObjects({
      bucket: "raw",
      client: client(async (cmd) => {
        sent.push(cmd.input);
        return {};
      }),
    });
    await raw.put("k", new Uint8Array(), {
      contentType: "application/json",
      contentEncoding: "gzip",
      tags: { tenant: "frost", layer: "raw" },
    });
    expect(sent[0].Tagging).toBe("tenant=frost&layer=raw");
    expect(sent[0].ContentEncoding).toBe("gzip");
  });

  it("omits the optional fields rather than sending empty ones", async () => {
    const sent: any[] = [];
    const raw = new S3RawObjects({
      bucket: "raw",
      client: client(async (cmd) => {
        sent.push(cmd.input);
        return {};
      }),
    });
    await raw.put("k", new Uint8Array());
    expect("Tagging" in sent[0]).toBe(false);
    expect("ContentType" in sent[0]).toBe(false);
  });
});

describe("listing", () => {
  it("follows pagination to the end", async () => {
    // A backfill that silently saw the first page would replay part of the raw
    // zone and report success, which is worse than being slow.
    let call = 0;
    const raw = new S3RawObjects({
      bucket: "raw",
      client: client(async () => {
        call += 1;
        return call === 1
          ? { Contents: [{ Key: "a" }, { Key: "b" }], NextContinuationToken: "t" }
          : { Contents: [{ Key: "c" }] };
      }),
    });
    expect(await raw.list("tenant=frost/")).toEqual(["a", "b", "c"]);
  });

  it("passes the continuation token back", async () => {
    const tokens: Array<string | undefined> = [];
    let call = 0;
    const raw = new S3RawObjects({
      bucket: "raw",
      client: client(async (cmd) => {
        tokens.push(cmd.input.ContinuationToken);
        call += 1;
        return call === 1 ? { Contents: [], NextContinuationToken: "t" } : { Contents: [] };
      }),
    });
    await raw.list("p");
    expect(tokens).toEqual([undefined, "t"]);
  });

  it("skips an entry with no key", async () => {
    // S3 can return one. Passing undefined onwards would make the next read fail
    // with a message about nothing in particular — this used to be the
    // transform's problem and is now storage's, where it belongs.
    const raw = new S3RawObjects({
      bucket: "raw",
      client: client(async () => ({ Contents: [{ Key: "a" }, {}, { Key: "b" }] })),
    });
    expect(await raw.list("p")).toEqual(["a", "b"]);
  });

  it("returns nothing for a prefix with no objects", async () => {
    const raw = new S3RawObjects({ bucket: "raw", client: client(async () => ({})) });
    expect(await raw.list("p")).toEqual([]);
  });
});

describe("construction", () => {
  it("builds its own client when not given one", () => {
    // The composition roots pass a bucket and a region; only tests pass a client.
    expect(() => new S3RawObjects({ bucket: "raw", region: "eu-west-1" })).not.toThrow();
    expect(() => new S3RawObjects({ bucket: "raw" })).not.toThrow();
  });
});

describe("what the port does not offer", () => {
  it("has no way to delete", () => {
    // The raw zone is the only thing in the system that cannot be rebuilt from
    // something else. Callers used to hold an S3Client, which is the whole API
    // including DeleteBucket, in order to read one object.
    expect("delete" in new S3RawObjects({ bucket: "raw", client: client(async () => ({})) })).toBe(false);
  });
});
