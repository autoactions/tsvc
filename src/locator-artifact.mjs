import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const LOCATOR_ARTIFACT_NAME = "session-deck-locators";
export const LOCATOR_ARTIFACT_FILE = "session-deck-output.md";

/**
 * @param {{ address: string, sensitiveFacts?: string, directory: string }} options
 * @returns {string}
 */
export function writeLocatorArtifact({ address, sensitiveFacts, directory }) {
  if (!isAbsolute(directory)) throw new Error("Locator Artifact directory is invalid.");
  const locators = ["## Locators", `- Session Address: ${address}`];
  const document = sensitiveFacts
    ? `${locators.join("\n")}\n\n${sensitiveFacts.trimEnd()}\n`
    : `${locators.join("\n")}\n`;
  const path = join(directory, LOCATOR_ARTIFACT_FILE);
  writeFileSync(path, document, { encoding: "utf8", mode: 0o600 });
  return path;
}

/** @param {string} path */
export async function uploadLocatorArtifact(path) {
  if (!isAbsolute(path)) throw new Error("Locator Artifact path is invalid.");
  const command = process.env.SESSION_DECK_UPLOAD_COMMAND;
  if (command) {
    const result = spawnSync(command, [path], { stdio: "ignore" });
    if (result.status !== 0) throw new Error("Locator Artifact upload failed.");
    return;
  }
  if (!process.env.ACTIONS_RUNTIME_TOKEN) return;
  const { DefaultArtifactClient } = await import("@actions/artifact");
  const client = new DefaultArtifactClient();
  const result = await client.uploadArtifact(LOCATOR_ARTIFACT_NAME, [path], dirname(path), {
    retentionDays: 1,
  });
  if (!result.id) throw new Error("Locator Artifact upload failed.");
}
