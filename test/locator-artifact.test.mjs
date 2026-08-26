import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeLocatorArtifact } from "../src/locator-artifact.mjs";

const encrypted = "enc:v2:AQIDBAUGBwgJCgsMDQ4PEA:ERITFBUWFxgZGhsc:VQqliAmCPeNzGYQntK9gCv1aF11urOp12WcrMSpu";

test("writes a Locators-only Artifact document for Chrome", () => {
  const directory = mkdtempSync(join(tmpdir(), "locator-artifact-"));
  try {
    const path = writeLocatorArtifact({
      address: "https://session-test.trycloudflare.com",
      directory,
    });
    assert.equal(
      readFileSync(path, "utf8"),
      "## Locators\n- Session Address: https://session-test.trycloudflare.com\n",
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("appends encrypted Sensitive Facts when the service publishes them", () => {
  const directory = mkdtempSync(join(tmpdir(), "locator-artifact-"));
  try {
    const path = writeLocatorArtifact({
      address: "https://session-test.trycloudflare.com",
      sensitiveFacts: `## Sensitive Facts\n\n- Motrix Operator Token: ${encrypted}\n`,
      directory,
    });
    assert.equal(
      readFileSync(path, "utf8"),
      `## Locators\n- Session Address: https://session-test.trycloudflare.com\n\n## Sensitive Facts\n\n- Motrix Operator Token: ${encrypted}\n`,
    );
  } finally {
    rmSync(directory, { recursive: true });
  }
});
