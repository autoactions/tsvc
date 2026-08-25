#!/usr/bin/env node

import { X509Certificate } from "node:crypto";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const destination = process.argv[2];
const source = process.env.DATABASE_CA ?? "";
delete process.env.DATABASE_CA;

/** @param {string} value */
function validCertificateBundle(value) {
  const matches = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (!matches || matches.join("\n").trim() !== value.trim()) return false;
  try {
    for (const certificate of matches) new X509Certificate(certificate);
    return true;
  } catch {
    return false;
  }
}

if (!destination || !isAbsolute(destination) || !validCertificateBundle(source)) {
  console.error("Database CA staging rejected invalid input.");
  process.exitCode = 2;
} else {
  process.umask(0o077);
  let descriptor;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    writeFileSync(descriptor, `${source.trim()}\n`, { encoding: "utf8" });
  } catch {
    console.error("Database CA staging failed.");
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
