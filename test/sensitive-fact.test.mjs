import assert from "node:assert/strict";
import test from "node:test";

import { encryptSensitiveFact, sensitiveFactsBlock } from "../src/sensitive-fact.mjs";

const random = {
  salt: Buffer.from(Array.from({ length: 16 }, (_, index) => index + 1)),
  iv: Buffer.from(Array.from({ length: 12 }, (_, index) => index + 17)),
};

test("Sensitive Fact v2 matches the cross-repository vector", () => {
  assert.equal(
    encryptSensitiveFact("Session Password", "private-value", "shared-session-password", random),
    "enc:v2:AQIDBAUGBwgJCgsMDQ4PEA:ERITFBUWFxgZGhsc:Shap0xyfNasoDIc5tPqGpuH_Muzis2PBzP3gu_A",
  );
});

test("Sensitive Facts block rejects invalid labels and envelopes", () => {
  assert.throws(() => encryptSensitiveFact("bad:label", "value", "password"));
  assert.throws(() => encryptSensitiveFact("Label", "", "password"));
  assert.throws(() => sensitiveFactsBlock([]));
  assert.throws(() => sensitiveFactsBlock([{ label: "Label", envelope: "plaintext" }]));
});
