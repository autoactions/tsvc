import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/stage-cloudflare-tunnel-token.mjs", import.meta.url).pathname;
const token = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";

test("SC-05 stages a Cloudflare Tunnel token in a mode-0600 file", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudflare-tunnel-token-"));
  const destination = join(directory, "token");
  const result = spawnSync(process.execPath, [script, destination], {
    env: { ...process.env, CLOUDFLARE_TUNNEL_TOKEN: token },
  });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(readFileSync(destination, "utf8"), token);
  assert.equal(statSync(destination).mode & 0o777, 0o600);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(token));
  rmSync(directory, { recursive: true });
});

test("SC-05 rejects empty tokens and existing destinations without leaking the token", () => {
  const directory = mkdtempSync(join(tmpdir(), "cloudflare-tunnel-token-"));
  const destination = join(directory, "token");
  const empty = spawnSync(process.execPath, [script, destination], {
    env: { ...process.env, CLOUDFLARE_TUNNEL_TOKEN: "" },
  });
  assert.notEqual(empty.status, 0);
  assert.throws(() => statSync(destination), { code: "ENOENT" });
  writeFileSync(destination, "existing", { mode: 0o600 });
  const overwrite = spawnSync(process.execPath, [script, destination], {
    env: { ...process.env, CLOUDFLARE_TUNNEL_TOKEN: token },
  });
  assert.notEqual(overwrite.status, 0);
  assert.equal(readFileSync(destination, "utf8"), "existing");
  assert.doesNotMatch(`${overwrite.stdout}${overwrite.stderr}`, new RegExp(token));
  rmSync(directory, { recursive: true });
});
