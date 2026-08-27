import { writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const LOCATOR_ARTIFACT_NAME = "session-deck-locators";
export const LOCATOR_ARTIFACT_FILE = "session-deck-output.md";

/**
 * @param {{ address: string, username?: string, sensitiveFacts?: string, directory: string }} options
 * @returns {string}
 */
export function writeLocatorArtifact({ address, username, sensitiveFacts, directory }) {
  if (!isAbsolute(directory)) throw new Error("Locator Artifact directory is invalid.");
  const locators = ["## Locators", `- Session Address: ${address}`];
  if (username) locators.push(`- Username: ${username}`);
  const document = sensitiveFacts
    ? `${locators.join("\n")}\n\n${sensitiveFacts.trimEnd()}\n`
    : `${locators.join("\n")}\n`;
  const path = join(directory, LOCATOR_ARTIFACT_FILE);
  writeFileSync(path, document, { encoding: "utf8", mode: 0o600 });
  return path;
}
