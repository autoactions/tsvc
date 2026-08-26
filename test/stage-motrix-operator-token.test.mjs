import assert from "node:assert/strict";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/stage-motrix-operator-token.mjs", import.meta.url).pathname;
const password = "shared-session-password";

/** @param {string} tokenDestination @param {string} factsDestination @param {string} [secret] */
function stage(tokenDestination, factsDestination, secret = password) {
  return spawnSync(process.execPath, [script, tokenDestination, factsDestination], {
    env: { ...process.env, SESSION_PASSWORD: secret },
  });
}

/** @param {string} block */
function decryptToken(block) {
  const match = block.match(/^- Motrix Operator Token: enc:v2:([^:]+):([^:]+):([^\s]+)$/m);
  assert.ok(match);
  const salt = Buffer.from(match[1] ?? "", "base64url");
  const iv = Buffer.from(match[2] ?? "", "base64url");
  const encrypted = Buffer.from(match[3] ?? "", "base64url");
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from("session-deck-sensitive-fact:v2:Motrix Operator Token"));
  decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
}

test("SC-01 generates a fresh mode-0600 Motrix Token and matching encrypted fact", () => {
  const tokens = [];
  for (let index = 0; index < 2; index++) {
    const directory = mkdtempSync(join(tmpdir(), "motrix-operator-token-test-"));
    const tokenDestination = join(directory, "motrix-operator-token");
    const factsDestination = join(directory, "sensitive-facts");
    const result = stage(tokenDestination, factsDestination);
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), "");
    const token = readFileSync(tokenDestination, "utf8");
    const block = readFileSync(factsDestination, "utf8");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(decryptToken(block), token);
    assert.doesNotMatch(block, new RegExp(token));
    assert.equal(statSync(tokenDestination).mode & 0o777, 0o600);
    assert.equal(statSync(factsDestination).mode & 0o777, 0o600);
    tokens.push(token);
    rmSync(directory, { recursive: true });
  }
  assert.notEqual(tokens[0], tokens[1]);
});

test("SC-01 rejects missing encryption input without disclosure or output", () => {
  const directory = mkdtempSync(join(tmpdir(), "motrix-operator-token-test-"));
  const tokenDestination = join(directory, "motrix-operator-token");
  const factsDestination = join(directory, "sensitive-facts");
  const result = stage(tokenDestination, factsDestination, "");
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.toString(), "");
  assert.doesNotMatch(result.stderr.toString(), /SESSION_PASSWORD|shared-session-password/);
  assert.throws(() => statSync(tokenDestination), { code: "ENOENT" });
  assert.throws(() => statSync(factsDestination), { code: "ENOENT" });
  rmSync(directory, { recursive: true });
});

test("SC-01 refuses to overwrite either destination", () => {
  const directory = mkdtempSync(join(tmpdir(), "motrix-operator-token-test-"));
  const tokenDestination = join(directory, "motrix-operator-token");
  const factsDestination = join(directory, "sensitive-facts");
  writeFileSync(tokenDestination, "existing", { mode: 0o600 });
  const result = stage(tokenDestination, factsDestination);
  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(tokenDestination, "utf8"), "existing");
  assert.throws(() => statSync(factsDestination), { code: "ENOENT" });
  rmSync(directory, { recursive: true });
});
