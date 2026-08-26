import assert from "node:assert/strict";
import test from "node:test";

import { encryptSensitiveFact, sensitiveFactsBlock } from "../src/sensitive-fact.mjs";

const random = {
  salt: Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1)),
  iv: Buffer.from(Array.from({ length: 12 }, (_, index) => index + 17)),
};

test("Sensitive Fact v1 matches the cross-repository vector", () => {
  assert.equal(
    encryptSensitiveFact("Session Password", "private-value", "shared-session-password", random),
    "enc:v1:AQIDBAUGBwgJCgsMDQ4PEA:ERITFBUWFxgZGhsc:8XYgVKM3GYZMpY15qf4NG8huLDN3f-XD3WdOmQw",
  );
});

test("Sensitive Facts block rejects invalid labels and envelopes", () => {
  assert.throws(() => encryptSensitiveFact("bad:label", "value", "password"));
  assert.throws(() => encryptSensitiveFact("Label", "", "password"));
  assert.throws(() => sensitiveFactsBlock([]));
  assert.throws(() => sensitiveFactsBlock([{ label: "Label", envelope: "plaintext" }]));
});
