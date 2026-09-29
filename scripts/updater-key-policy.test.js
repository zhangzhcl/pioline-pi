import { describe, expect, it } from "vitest";
import { decodeUpdaterPublicKey } from "./updater-key-policy.js";

const validPublicKey =
  "untrusted comment: minisign public key: Pipline test fixture\n" +
  "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";

describe("decodeUpdaterPublicKey", () => {
  it("accepts a valid 42-byte minisign public key", () => {
    expect(decodeUpdaterPublicKey(validPublicKey)).toBe(validPublicKey);
  });

  it("rejects the inherited Picot updater identity", () => {
    expect(() =>
      decodeUpdaterPublicKey(
        "untrusted comment: minisign public key: Picot\n" +
          "RWThHFEQ+Yyd6SRkMecH9KYm3pc0rauF1uwlsnTJwYt0ExfrxjTkbUea",
      ),
    ).toThrow("Replace the inherited Picot updater key");
  });

  it("rejects truncated or noncanonical key material", () => {
    const truncated = validPublicKey.replace(
      "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3",
      "RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GF",
    );
    expect(() => decodeUpdaterPublicKey(truncated)).toThrow(
      "not a valid Pipline updater public key",
    );
  });
});
