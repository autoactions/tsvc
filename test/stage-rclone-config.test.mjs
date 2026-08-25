import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/stage-rclone-config.mjs", import.meta.url).pathname;

test("SC-03 stages the complete rclone configuration in a mode-0600 file", () => {
  const directory = mkdtempSync(join(tmpdir(), "rclone-config-test-"));
  const destination = join(directory, "rclone.conf");
  const config = "[archive]\ntype = s3\naccess_key_id = example\nsecret_access_key = hidden\n";
  const result = spawnSync(process.execPath, [script, destination], {
    env: { ...process.env, RCLONE_CONFIG: config },
  });

  try {
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(result.stdout.toString(), "");
    assert.equal(result.stderr.toString(), "");
    assert.equal(readFileSync(destination, "utf8"), config);
    assert.equal(statSync(destination).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("SC-03 rejects empty configuration and existing destinations without disclosure", () => {
  for (const existing of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "rclone-config-test-"));
    const destination = join(directory, "rclone.conf");
    if (existing) writeFileSync(destination, "existing", { mode: 0o600 });
    const secret = existing ? "[archive]\ntype = memory\n" : "";
    const result = spawnSync(process.execPath, [script, destination], {
      env: { ...process.env, RCLONE_CONFIG: secret },
    });

    try {
      assert.notEqual(result.status, 0);
      assert.equal(result.stdout.toString(), "");
      assert.doesNotMatch(result.stderr.toString(), /archive|memory|existing/);
      if (!existing) assert.throws(() => statSync(destination), { code: "ENOENT" });
      else assert.equal(readFileSync(destination, "utf8"), "existing");
    } finally {
      rmSync(directory, { recursive: true });
    }
  }
});
