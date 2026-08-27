import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("IM-01 cloudflared acquisition verifies the exact immutable artifact", () => {
  const script = readFileSync(
    new URL("../scripts/acquire-cloudflared.sh", import.meta.url),
    "utf8",
  );

  assert.match(
    script,
    /https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/2026\.8\.2\/cloudflared-linux-amd64/,
  );
  assert.match(
    script,
    /fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2/,
  );
  assert.match(script, /sha256sum --check/);
  assert.match(script, /--version/);
  assert.match(script, /2026\\\.8\\\.2/);
  assert.match(script, /RUNNER_TEMP/);
  assert.doesNotMatch(script, /latest|apt-get|sudo/);
});

test("IM-02 the mount foundation uses the reviewed immutable rclone image", () => {
  const module = readFileSync(
    new URL("../src/service-module.mjs", import.meta.url),
    "utf8",
  );

  assert.match(
    module,
    /rclone\/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548/,
  );
  assert.doesNotMatch(module, /rclone\/rclone:(?:latest|beta|master)/);
});

test("IM-03 OpenList AIO uses the reviewed immutable linux-amd64 image", () => {
  const module = readFileSync(
    new URL("../src/service-module.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    module,
    /openlistteam\/openlist@sha256:b4de1e8e07de352a57e8f9eefbe5525c4a6eeef0ae4c74c2a1e68cb71d185fdb/,
  );
  assert.doesNotMatch(module, /openlistteam\/openlist:(?:aio|latest|latest-aio|beta-aio)/);
});
