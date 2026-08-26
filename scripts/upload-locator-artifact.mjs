#!/usr/bin/env node

import { isAbsolute } from "node:path";

import { uploadLocatorArtifact } from "../src/locator-artifact.mjs";

const path = process.argv[2] ?? "";
if (!path || !isAbsolute(path)) {
  console.error("Locator Artifact path is invalid.");
  process.exit(2);
}

try {
  await uploadLocatorArtifact(path);
} catch (error) {
  const message = error instanceof Error ? error.message : "Locator Artifact upload failed.";
  console.error(message);
  process.exit(2);
}
