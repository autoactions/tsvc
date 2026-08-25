#!/usr/bin/env node

import { closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { isSessionCredential } from "../src/session-credential.mjs";

const destination = process.argv[2];
const credential = process.env.SESSION_PASSWORD ?? "";
delete process.env.SESSION_PASSWORD;

if (
  !destination ||
  !isAbsolute(destination) ||
  !isSessionCredential(credential)
) {
  console.error("Session Credential staging rejected invalid input.");
  process.exitCode = 2;
} else {
  process.umask(0o077);
  let descriptor;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    writeFileSync(descriptor, credential, { encoding: "utf8" });
  } catch {
    console.error("Session Credential staging failed.");
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
