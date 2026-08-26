import { createCipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const ITERATIONS = 600_000;
const LABEL_PATTERN = /^[^:\r\n]{1,80}$/;

/**
 * @param {string} label
 * @param {string} value
 * @param {string} password
 * @param {{ salt?: Buffer, iv?: Buffer }} [random]
 */
export function encryptSensitiveFact(label, value, password, random = {}) {
  if (!LABEL_PATTERN.test(label) || !value || !password || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new Error("Sensitive Fact encryption input is invalid.");
  }
  const salt = random.salt ?? randomBytes(16);
  const iv = random.iv ?? randomBytes(12);
  if (salt.length !== 16 || iv.length !== 12) throw new Error("Sensitive Fact randomness is invalid.");
  const key = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`session-deck-sensitive-fact:v1:${label}`, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `enc:v1:${salt.toString("base64url")}:${iv.toString("base64url")}:${encrypted.toString("base64url")}`;
}

/** @param {{ label: string, envelope: string }[]} facts */
export function sensitiveFactsBlock(facts) {
  if (!Array.isArray(facts) || facts.length === 0 || facts.length > 8) throw new Error("Sensitive Facts are empty.");
  const labels = new Set();
  for (const fact of facts) {
    if (
      !LABEL_PATTERN.test(fact.label) || labels.has(fact.label) || fact.envelope.length > 5_600 ||
      !/^enc:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(fact.envelope)
    ) {
      throw new Error("Sensitive Fact is invalid.");
    }
    labels.add(fact.label);
  }
  return ["## Sensitive Facts", "", ...facts.map(({ label, envelope }) => `- ${label}: ${envelope}`), ""].join("\n");
}
