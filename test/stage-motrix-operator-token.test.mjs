import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/stage-motrix-operator-token.mjs", import.meta.url).pathname;

/** @param {string} token @param {string} destination */
function stage(token, destination) {
  return spawnSync(process.execPath, [script, destination], {
    env: { ...process.env, MOTRIX_OPERATOR_TOKEN: token },
  });
}

test("SC-01 stages 43-128 character Motrix Operator Tokens in a mode-0600 file", () => {
  for (const token of ["A".repeat(43), `${"a".repeat(125)}_-0`, "Z".repeat(128)]) {
    const directory = mkdtempSync(join(tmpdir(), "motrix-operator-token-test-"));
    const destination = join(directory, "motrix-operator-token");
    const result = stage(token, destination);

    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), "");
    assert.equal(result.stderr.toString(), "");
    assert.equal(readFileSync(destination, "utf8"), token);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
    rmSync(directory, { recursive: true });
  }
});

test("SC-01 rejects invalid Motrix Operator Tokens without disclosure or output", () => {
  const invalid = ["", "A".repeat(42), "A".repeat(129), `${"A".repeat(42)}!`, `${"A".repeat(42)} `];
  for (const token of invalid) {
    const directory = mkdtempSync(join(tmpdir(), "motrix-operator-token-test-"));
    const destination = join(directory, "motrix-operator-token");
    const result = stage(token, destination);

    assert.notEqual(result.status, 0);
    assert.equal(result.stdout.toString(), "");
    assert.doesNotMatch(result.stderr.toString(), new RegExp(token || "token-must-not-appear"));
    assert.throws(() => statSync(destination), { code: "ENOENT" });
    rmSync(directory, { recursive: true });
  }
});

test("SC-01 refuses to overwrite an existing Motrix Operator Token file", () => {
  const directory = mkdtempSync(join(tmpdir(), "motrix-operator-token-test-"));
  const destination = join(directory, "motrix-operator-token");
  writeFileSync(destination, "existing", { mode: 0o600 });
  const token = "A".repeat(43);
  const result = stage(token, destination);

  assert.notEqual(result.status, 0);
  assert.equal(readFileSync(destination, "utf8"), "existing");
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
  rmSync(directory, { recursive: true });
});
