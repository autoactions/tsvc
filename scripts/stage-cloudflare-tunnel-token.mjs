#!/usr/bin/env node

import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const destination = process.argv[2];
const token = process.env.CLOUDFLARE_TUNNEL_TOKEN ?? "";
delete process.env.CLOUDFLARE_TUNNEL_TOKEN;

if (!destination || !isAbsolute(destination) || token.length === 0) {
  console.error("Cloudflare Tunnel token staging rejected invalid input.");
  process.exitCode = 2;
} else {
  process.umask(0o077);
  let descriptor;
  let created = false;
  try {
    descriptor = openSync(destination, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, token, { encoding: "utf8" });
  } catch {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
    }
    if (created) {
      try { unlinkSync(destination); } catch {}
    }
    console.error("Cloudflare Tunnel token staging failed.");
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
