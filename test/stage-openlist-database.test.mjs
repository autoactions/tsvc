import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const databaseScript = new URL("../scripts/stage-openlist-database.mjs", import.meta.url).pathname;
const caScript = new URL("../scripts/stage-openlist-database-ca.mjs", import.meta.url).pathname;

function certificate() {
  const root = mkdtempSync(join(tmpdir(), "openlist-ca-source-"));
  const key = join(root, "key.pem");
  const cert = join(root, "ca.pem");
  const result = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=OpenList Test CA", "-keyout", key, "-out", cert,
  ]);
  assert.equal(result.status, 0, result.stderr.toString());
  const value = readFileSync(cert, "utf8");
  assert.doesNotThrow(() => new X509Certificate(value));
  rmSync(root, { recursive: true });
  return value;
}

test("SC-04 stages canonical database JSON and a CA bundle as mode-0600 files", () => {
  const root = mkdtempSync(join(tmpdir(), "openlist-staging-"));
  const databasePath = join(root, "database.json");
  const caPath = join(root, "database-ca.pem");
  const database = {
    host: "mysql.internal.example", port: 3306, user: "openlist",
    password: "database-secret", name: "openlist",
  };
  const ca = certificate();
  try {
    const databaseResult = spawnSync(process.execPath, [databaseScript, databasePath], {
      env: { ...process.env, OPENLIST_DATABASE: JSON.stringify(database) },
    });
    const caResult = spawnSync(process.execPath, [caScript, caPath], {
      env: { ...process.env, OPENLIST_DATABASE_CA: ca },
    });
    assert.equal(databaseResult.status, 0, databaseResult.stderr.toString());
    assert.equal(caResult.status, 0, caResult.stderr.toString());
    assert.deepEqual(JSON.parse(readFileSync(databasePath, "utf8")), database);
    assert.equal(readFileSync(caPath, "utf8"), `${ca.trim()}\n`);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    assert.equal(statSync(caPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("SC-04 rejects invalid or existing targets without disclosing Secret values", () => {
  const secret = "database-password-not-for-output";
  /** @type {[string, string, string][]} */
  const cases = [
    [databaseScript, "OPENLIST_DATABASE", JSON.stringify({ host: "bad_host", port: 3306, user: "u", password: secret, name: "db" })],
    [caScript, "OPENLIST_DATABASE_CA", `not-a-certificate-${secret}`],
  ];
  for (const [script, envName, value] of cases) {
    const root = mkdtempSync(join(tmpdir(), "openlist-staging-invalid-"));
    const destination = join(root, "secret");
    writeFileSync(destination, "existing", { mode: 0o600 });
    try {
      const result = spawnSync(process.execPath, [script, destination], {
        env: { ...process.env, [envName]: value },
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
      assert.equal(readFileSync(destination, "utf8"), "existing");
    } finally {
      rmSync(root, { recursive: true });
    }
  }
});
