#!/usr/bin/env node

import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { isSessionCredential } from "../src/session-credential.mjs";
import { encryptSensitiveFact, sensitiveFactsBlock } from "../src/sensitive-fact.mjs";

const destination = process.argv[2];
const factsDestination = process.argv[3];
const credential = process.env.SESSION_PASSWORD ?? "";
delete process.env.SESSION_PASSWORD;

if (
  !destination || !factsDestination ||
  !isAbsolute(destination) || !isAbsolute(factsDestination) ||
  destination === factsDestination ||
  !isSessionCredential(credential)
) {
  console.error("Session Credential staging rejected invalid input.");
  process.exitCode = 2;
} else {
  process.umask(0o077);
  const block = sensitiveFactsBlock([{
    label: "Session Credential",
    envelope: encryptSensitiveFact("Session Credential", credential, credential),
  }]);
  /** @type {number[]} */
  const descriptors = [];
  /** @type {string[]} */
  const created = [];
  try {
    const credentialDescriptor = openSync(destination, "wx", 0o600);
    descriptors.push(credentialDescriptor);
    created.push(destination);
    writeFileSync(credentialDescriptor, credential, { encoding: "utf8" });
    const factsDescriptor = openSync(factsDestination, "wx", 0o600);
    descriptors.push(factsDescriptor);
    created.push(factsDestination);
    writeFileSync(factsDescriptor, block, { encoding: "utf8" });
  } catch {
    for (const descriptor of descriptors.splice(0)) closeSync(descriptor);
    for (const path of created) {
      try { unlinkSync(path); } catch {}
    }
    console.error("Session Credential staging failed.");
    process.exitCode = 1;
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
}
