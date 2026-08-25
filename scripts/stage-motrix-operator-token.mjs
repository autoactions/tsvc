#!/usr/bin/env node

import { closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { isMotrixOperatorToken } from "../src/motrix-operator-token.mjs";

const destination = process.argv[2];
const token = process.env.MOTRIX_OPERATOR_TOKEN ?? "";
delete process.env.MOTRIX_OPERATOR_TOKEN;

if (!destination || !isAbsolute(destination) || !isMotrixOperatorToken(token)) {
  console.error("Motrix Operator Token staging rejected invalid input.");
  process.exitCode = 2;
} else {
  process.umask(0o077);
  let descriptor;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    writeFileSync(descriptor, token, { encoding: "utf8" });
  } catch {
    console.error("Motrix Operator Token staging failed.");
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
