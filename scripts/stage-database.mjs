#!/usr/bin/env node

import { closeSync, openSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

import { parseDatabase } from "../src/database.mjs";

const destination = process.argv[2];
const source = process.env.DATABASE ?? "";
delete process.env.DATABASE;

let database;
try {
  database = parseDatabase(source);
} catch {
  database = undefined;
}

if (!destination || !isAbsolute(destination) || !database) {
  console.error("Database configuration staging rejected invalid input.");
  process.exitCode = 2;
} else {
  process.umask(0o077);
  let descriptor;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(database), { encoding: "utf8" });
  } catch {
    console.error("Database configuration staging failed.");
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
