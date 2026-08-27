#!/usr/bin/env node

import { openSync, closeSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseRcloneMounts } from "../src/rclone-mounts.mjs";

const destination = process.argv[2];
const source = process.env.RCLONE_MOUNTS ?? "";
delete process.env.RCLONE_MOUNTS;
let created = false;

try {
  if (!destination || !isAbsolute(destination)) throw new Error();
  process.umask(0o077);
  const mounts = parseRcloneMounts(source);
  const descriptor = openSync(destination, "wx", 0o600);
  created = true;
  try {
    writeFileSync(descriptor, `${mounts.map(({ id, source: value }) => `${id}=${value}`).join("\n")}\n`);
  } finally {
    closeSync(descriptor);
  }
} catch {
  if (destination && created) {
    try { unlinkSync(destination); } catch {}
  }
  console.error("Rclone mounts staging failed.");
  process.exitCode = 2;
}
