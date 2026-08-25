#!/usr/bin/env node

import { closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const destination = process.argv[2];
const config = process.env.RCLONE_CONFIG ?? "";
delete process.env.RCLONE_CONFIG;

if (!destination || !isAbsolute(destination) || config.trim().length === 0) {
  console.error("Rclone configuration staging rejected invalid input.");
  process.exitCode = 2;
} else {
  process.umask(0o077);
  let descriptor;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    writeFileSync(descriptor, config, { encoding: "utf8" });
  } catch {
    console.error("Rclone configuration staging failed.");
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
