import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const reap = new URL("../scripts/reap-session.sh", import.meta.url).pathname;

test("reap-session SIGKILLs a setsid process that ignores SIGTERM", () => {
  const directory = mkdtempSync(join(tmpdir(), "reap-session-"));
  try {
    const started = spawnSync("bash", ["-c", `
      set -euo pipefail
      setsid bash -c 'trap "" TERM; sleep 60' </dev/null >/dev/null 2>&1 &
      printf '%s\\n' "$!"
    `], { encoding: "utf8", cwd: directory });
    assert.equal(started.status, 0, started.stderr);
    const pid = started.stdout.trim();
    assert.match(pid, /^[0-9]+$/);
    assert.equal(spawnSync("kill", ["-0", pid]).status, 0, "fixture process must still be running");
    const begin = Date.now();
    const result = spawnSync("bash", [reap, pid, "0"], { encoding: "utf8", timeout: 3000 });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(Date.now() - begin < 2000, "reap with grace 0 must not wait out the Session");
    assert.notEqual(spawnSync("kill", ["-0", pid]).status, 0);
  } finally {
    rmSync(directory, { recursive: true });
  }
});
