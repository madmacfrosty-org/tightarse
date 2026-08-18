import { describe, it, expect, vi } from "vitest";
import { SnsNotifications } from "./notifications";

describe("publishing", () => {
  it("sends to the topic it was constructed with", async () => {
    const sent: any[] = [];
    const n = new SnsNotifications({
      topicArn: "arn:topic",
      client: { send: vi.fn(async (cmd: any) => sent.push(cmd.input)) } as any,
    });
    await n.publish("Sync failed", "four items");
    expect(sent[0]).toMatchObject({ TopicArn: "arn:topic", Subject: "Sync failed", Message: "four items" });
  });

  it("offers no way to subscribe or unsubscribe", () => {
    // Delivery is not the application's concern, and an application that could
    // subscribe an address could also remove one.
    const n = new SnsNotifications({ topicArn: "t", client: { send: vi.fn() } as any });
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(n))).toEqual(["constructor", "publish"]);
  });
});

describe("construction", () => {
  it("builds its own client when not given one", () => {
    expect(() => new SnsNotifications({ topicArn: "t", region: "eu-west-1" })).not.toThrow();
    expect(() => new SnsNotifications({ topicArn: "t" })).not.toThrow();
  });
});
