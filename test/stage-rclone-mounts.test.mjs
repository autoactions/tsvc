import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/stage-rclone-mounts.mjs", import.meta.url).pathname;

test("SC-03 stages canonical mode-0600 Rclone mounts", () => {
  const root = mkdtempSync(join(tmpdir(), "rclone-mounts-test-"));
  const destination = join(root, "mounts");
  try {
    const result = spawnSync(process.execPath, [script, destination], {
      env: { ...process.env, RCLONE_MOUNTS: " archive = drive:folder \nmedia=s3:bucket/media" },
    });
    assert.equal(result.status, 0, result.stderr.toString());
    assert.equal(readFileSync(destination, "utf8"), "archive=drive:folder\nmedia=s3:bucket/media\n");
    assert.equal(statSync(destination).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("SC-03 rejects invalid declarations and existing targets", () => {
  const root = mkdtempSync(join(tmpdir(), "rclone-mounts-test-"));
  try {
    for (const mounts of ["", "bad/id=drive:"]) {
      const result = spawnSync(process.execPath, [script, join(root, `mounts-${Math.random()}`)], {
        env: { ...process.env, RCLONE_MOUNTS: mounts },
      });
      assert.equal(result.status, 2);
      assert.doesNotMatch(result.stderr.toString(), /drive:/);
    }
    const destination = join(root, "existing");
    const first = spawnSync(process.execPath, [script, destination], {
      env: { ...process.env, RCLONE_MOUNTS: "archive=drive:" },
    });
    const second = spawnSync(process.execPath, [script, destination], {
      env: { ...process.env, RCLONE_MOUNTS: "media=s3:" },
    });
    assert.equal(first.status, 0);
    assert.equal(second.status, 2);
    assert.equal(readFileSync(destination, "utf8"), "archive=drive:\n");
  } finally {
    rmSync(root, { recursive: true });
  }
});
