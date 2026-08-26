#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { encryptSensitiveFact, sensitiveFactsBlock } from "../src/sensitive-fact.mjs";

const tokenDestination = process.argv[2];
const factsDestination = process.argv[3];
const password = process.env.SESSION_PASSWORD ?? "";
delete process.env.SESSION_PASSWORD;

if (
  !tokenDestination || !factsDestination ||
  !isAbsolute(tokenDestination) || !isAbsolute(factsDestination) ||
  tokenDestination === factsDestination || !password
) {
  console.error("Motrix Operator Token staging rejected invalid input.");
  process.exitCode = 2;
} else {
  process.umask(0o077);
  const token = randomBytes(32).toString("base64url");
  const block = sensitiveFactsBlock([{
    label: "Motrix Operator Token",
    envelope: encryptSensitiveFact("Motrix Operator Token", token, password),
  }]);
  /** @type {number[]} */
  const descriptors = [];
  /** @type {string[]} */
  const created = [];
  try {
    const tokenDescriptor = openSync(tokenDestination, "wx", 0o600);
    descriptors.push(tokenDescriptor);
    created.push(tokenDestination);
    writeFileSync(tokenDescriptor, token, { encoding: "utf8" });
    const factsDescriptor = openSync(factsDestination, "wx", 0o600);
    descriptors.push(factsDescriptor);
    created.push(factsDestination);
    writeFileSync(factsDescriptor, block, { encoding: "utf8" });
  } catch {
    for (const descriptor of descriptors.splice(0)) closeSync(descriptor);
    for (const path of created) {
      try { unlinkSync(path); } catch {}
    }
    console.error("Motrix Operator Token staging failed.");
    process.exitCode = 1;
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}
