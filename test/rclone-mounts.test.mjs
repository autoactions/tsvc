import assert from "node:assert/strict";
import test from "node:test";

import { parseRcloneMounts } from "../src/rclone-mounts.mjs";

test("SC-03 parses concise Rclone mount declarations", () => {
  assert.deepEqual(parseRcloneMounts("archive=drive:archive\n\nmedia=s3:bucket/media\n"), [
    { id: "archive", source: "drive:archive", remote: "drive" },
    { id: "media", source: "s3:bucket/media", remote: "s3" },
  ]);
});

test("SC-03 rejects ambiguous or unsafe Rclone mounts", () => {
  for (const source of [
    "", "bad/id=drive:", "same=drive:\nsame=s3:", "archive=missing-colon",
    "archive=:path", "archive=drive:\u0000path",
  ]) assert.throws(() => parseRcloneMounts(source), /invalid rclone mounts/);
});
