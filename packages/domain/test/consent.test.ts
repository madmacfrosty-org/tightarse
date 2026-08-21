import { describe, it, expect } from "vitest";
import { ConsentExpired } from "../src/index.js";

/**
 * The one provider failure the application has to tell apart.
 *
 * This package is otherwise interfaces, which is why its coverage threshold sits
 * at 100 on nothing — so that the day it grows a function, the number moves and
 * somebody notices. This is that day.
 *
 * The contract is narrow but load-bearing: an adapter throws it, the sync step
 * catches it by identity, and the difference between catching it and not is
 * whether a household is told to re-authorise or a connection quietly stops
 * updating.
 */

describe("a lapsed consent", () => {
  it("is identifiable by instanceof, which is how the sync step catches it", () => {
    // Not by message and not by a status code. Both belong to whichever provider
    // raised it, and matching on them is what put TrueLayer's error taxonomy in
    // the sync step in the first place.
    const err = new ConsentExpired("invalid_grant on refresh");
    expect(err).toBeInstanceOf(ConsentExpired);
    expect(err).toBeInstanceOf(Error);
  });

  it("carries its own name, so a log line says what happened", () => {
    // Without setting it explicitly a subclass reports "Error", and the alert a
    // person reads would name nothing useful.
    expect(new ConsentExpired("gone").name).toBe("ConsentExpired");
  });

  it("keeps the message it was given", () => {
    expect(new ConsentExpired("consent expired for conn-1").message).toBe("consent expired for conn-1");
  });

  it("is not satisfied by an ordinary error that happens to say the same thing", () => {
    // The reason it is a class rather than a message convention: a transient 500
    // whose body mentioned consent would otherwise send someone to re-authorise a
    // working connection.
    expect(new Error("ConsentExpired")).not.toBeInstanceOf(ConsentExpired);
  });
});
