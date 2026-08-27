import assert from "node:assert/strict";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/stage-credential.mjs", import.meta.url).pathname;
const validCredentials = ["1", "123456", "simple password", "password!", " ", "line one\nline two"];

/** @param {string} block @param {string} password */
function decrypt(block, password) {
  const match = block.match(/^- Session Credential: enc:v2:([^:]+):([^:]+):([^\s]+)$/m);
  assert.ok(match);
  const saltText = match[1];
  const ivText = match[2];
  const encryptedText = match[3];
  assert.ok(saltText && ivText && encryptedText);
  const salt = Buffer.from(saltText, "base64url");
  const iv = Buffer.from(ivText, "base64url");
  const encrypted = Buffer.from(encryptedText, "base64url");
  const key = pbkdf2Sync(password, salt, 100_000, 32, "sha256");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from("session-deck-sensitive-fact:v2:Session Credential"));
  decipher.setAuthTag(encrypted.subarray(-16));
  return Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8");
}

test("SC-01 stages any non-empty Chrome Session Credential in a mode-0600 file", () => {
  for (const credential of validCredentials) {
    const directory = mkdtempSync(join(tmpdir(), "session-credential-test-"));
    const destination = join(directory, "session-credential");
    const factsDestination = join(directory, "sensitive-facts");
    const result = spawnSync(process.execPath, [script, destination, factsDestination], {
      env: { ...process.env, SESSION_PASSWORD: credential },
    });

    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), "");
    assert.equal(result.stderr.toString(), "");
    assert.equal(readFileSync(destination, "utf8"), credential);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    const facts = readFileSync(factsDestination, "utf8");
    assert.equal(decrypt(facts, credential), credential);
    assert.match(facts, /^## Sensitive Facts\n\n- Session Credential: enc:v2:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\n$/);
    assert.equal(statSync(factsDestination).mode & 0o777, 0o600);
    rmSync(directory, { recursive: true });
  }
});

test("SC-01 rejects an empty Session Credential without writing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-credential-test-"));
  const destination = join(directory, "session-credential");
  const factsDestination = join(directory, "sensitive-facts");
  const result = spawnSync(process.execPath, [script, destination, factsDestination], {
    env: { ...process.env, SESSION_PASSWORD: "" },
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.toString(), "");
  assert.doesNotMatch(result.stderr.toString(), /SESSION_PASSWORD=/);
  assert.throws(() => statSync(destination), { code: "ENOENT" });
  assert.throws(() => statSync(factsDestination), { code: "ENOENT" });
  rmSync(directory, { recursive: true });
});

test("SC-01 refuses to overwrite either Session Credential destination", () => {
  for (const existing of ["credential", "facts"]) {
    const directory = mkdtempSync(join(tmpdir(), "session-credential-test-"));
    const destination = join(directory, "session-credential");
    const factsDestination = join(directory, "sensitive-facts");
    const existingPath = existing === "credential" ? destination : factsDestination;
    writeFileSync(existingPath, "existing", { mode: 0o600 });
    const result = spawnSync(process.execPath, [script, destination, factsDestination], {
      env: { ...process.env, SESSION_PASSWORD: "shared-session-password" },
    });

    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(existingPath, "utf8"), "existing");
    const absentPath = existing === "credential" ? factsDestination : destination;
    assert.throws(() => statSync(absentPath), { code: "ENOENT" });
    assert.doesNotMatch(result.stderr.toString(), /shared-session-password/);
    rmSync(directory, { recursive: true });
  }
});
