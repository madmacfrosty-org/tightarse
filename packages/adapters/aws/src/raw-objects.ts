/**
 * S3 as the raw landing zone.
 *
 * The adapter for `RawObjects`. It offers get, put and list, and no delete —
 * because the port offers no delete, and the port offers none because nothing in
 * this application may remove the only data that cannot be rebuilt from
 * something else.
 */

import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { RawObjects } from "@tightarse/domain";

export interface S3RawObjectsOptions {
  readonly bucket: string;
  readonly client?: S3Client;
  readonly region?: string;
}

export class S3RawObjects implements RawObjects {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(opts: S3RawObjectsOptions) {
    this.bucket = opts.bucket;
    this.s3 = opts.client ?? new S3Client(opts.region ? { region: opts.region } : {});
  }

  async get(key: string): Promise<Uint8Array> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = await res.Body?.transformToByteArray();
    if (body === undefined) {
      // An object that exists but has no body is not a case the callers can do
      // anything sensible with, and returning empty bytes would look like a
      // provider response containing nothing.
      throw new Error(`Raw object has no body: ${key}`);
    }
    return body;
  }

  async put(
    key: string,
    body: Uint8Array,
    opts: { contentType?: string; contentEncoding?: string; tags?: Record<string, string> } = {},
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(opts.contentType ? { ContentType: opts.contentType } : {}),
        ...(opts.contentEncoding ? { ContentEncoding: opts.contentEncoding } : {}),
        ...(opts.tags ? { Tagging: new URLSearchParams(opts.tags).toString() } : {}),
      }),
    );
  }

  /**
   * Every key under a prefix, following pagination.
   *
   * The caller gets all of them rather than a page. A backfill that silently saw
   * the first thousand objects would replay part of the raw zone and report
   * success, which is worse than being slow.
   */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.NextContinuationToken;
    } while (token);
    return keys;
  }
}
