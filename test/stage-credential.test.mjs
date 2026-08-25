import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/stage-credential.mjs", import.meta.url).pathname;
const validCredentials = ["1", "123456", "simple password", "password!", " ", "line one\nline two"];

test("SC-01 stages any non-empty Chrome Session Credential in a mode-0600 file", () => {
  for (const credential of validCredentials) {
    const directory = mkdtempSync(join(tmpdir(), "session-credential-test-"));
    const destination = join(directory, "session-credential");
    const result = spawnSync(process.execPath, [script, destination], {
      env: { ...process.env, SESSION_PASSWORD: credential },
    });

    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), "");
    assert.equal(result.stderr.toString(), "");
    assert.equal(readFileSync(destination, "utf8"), credential);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    rmSync(directory, { recursive: true });
  }
});

test("SC-01 rejects an empty Session Credential without writing it", () => {
  const directory = mkdtempSync(join(tmpdir(), "session-credential-test-"));
  const destination = join(directory, "session-credential");
  const result = spawnSync(process.execPath, [script, destination], {
    env: { ...process.env, SESSION_PASSWORD: "" },
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout.toString(), "");
  assert.doesNotMatch(result.stderr.toString(), /SESSION_PASSWORD=/);
  assert.throws(() => statSync(destination), { code: "ENOENT" });
  rmSync(directory, { recursive: true });
});
