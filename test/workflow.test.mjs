import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/tsvc.yml", import.meta.url), "utf8");

/** @param {string} name @param {string} next */
function stepScript(name, next) {
  const match = workflow.match(new RegExp(
    `- name: ${name}\\n[\\s\\S]*?run: \\|\\n([\\s\\S]*?)\\n\\s+- name: ${next}`,
  ));
  assert.ok(match?.[1], `${name} must remain statically inspectable`);
  return match[1].replace(/^ {10}/gm, "");
}

test("WF-01 exposes only Chrome and OpenList", () => {
  assert.match(workflow, /options:\n\s+- chrome\n\s+- openlist/);
  assert.doesNotMatch(workflow, /58081|agalwood|operator-token/i);
});

test("WF-01 rejects invalid raw dispatch values before checkout", () => {
  const script = stepScript("Validate closed inputs", "Validate optional Rclone configuration");
  for (const service of ["chrome", "openlist"]) {
    assert.equal(spawnSync("bash", ["-c", script], {
      env: { ...process.env, INPUT_SERVICE: service },
    }).status, 0);
  }
  assert.equal(spawnSync("bash", ["-c", script], {
    env: { ...process.env, INPUT_SERVICE: "other" },
  }).status, 2);
});

test("WF-03 validates optional Rclone mounts", () => {
  const script = stepScript("Validate optional Rclone configuration", "Validate database configuration");
  /** @param {string} configured @param {string} mounts */
  const validate = (configured, mounts) => spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      RCLONE_CONFIG_CONFIGURED: configured,
      RCLONE_MOUNTS: mounts,
    },
  });
  assert.equal(validate("false", "").status, 0);
  assert.equal(validate("true", "").status, 0);
  assert.equal(validate("true", "archive=drive:archive\nmedia=s3:bucket/media").status, 0);
  for (const [configured, mounts] of /** @type {[string, string][]} */ ([
    ["false", "archive=drive:"],
    ["true", "bad/id=drive:"],
    ["true", "same=drive:\nsame=s3:"],
    ["true", "archive=missing-colon"],
  ])) assert.equal(validate(configured, mounts).status, 2);
});

test("WF-04 requires the OpenList database pair", () => {
  const script = stepScript("Validate database configuration", "Record Session start");
  /** @param {string} service @param {string} database @param {string} ca */
  const validate = (service, database, ca) => spawnSync("bash", ["-c", script], {
    env: {
      ...process.env,
      INPUT_SERVICE: service,
      DATABASE_CONFIGURED: database,
      DATABASE_CA_CONFIGURED: ca,
    },
  });
  assert.equal(validate("chrome", "false", "false").status, 0);
  assert.equal(validate("openlist", "true", "true").status, 0);
  assert.equal(validate("openlist", "true", "false").status, 2);
  assert.equal(validate("openlist", "false", "true").status, 2);
});

test("WF-01 keeps immutable execution policy", () => {
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /timeout-minutes: 330/);
  assert.match(workflow, /group: \$\{\{ inputs\.service == 'openlist' && 'tsvc-serialized'/);
  assert.match(workflow, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/);
  assert.match(workflow, /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/);
  assert.match(workflow, /rclone\/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548/);
  assert.match(workflow, /openlistteam\/openlist@sha256:b4de1e8e07de352a57e8f9eefbe5525c4a6eeef0ae4c74c2a1e68cb71d185fdb/);
});

test("SC-01 uses the Session Credential for both public services", () => {
  const credential = workflow.match(
    /- name: Stage Session Credential\n([\s\S]*?)\n\s+- name: Stage Rclone configuration/,
  )?.[1] ?? "";
  assert.match(credential, /inputs\.service == 'chrome' \|\| inputs\.service == 'openlist'/);
  assert.match(credential, /secrets\.SESSION_PASSWORD/);
});

test("SC-03 stages generic Rclone files and passes paired Session arguments", () => {
  assert.match(workflow, /- name: Stage Rclone configuration\n\s+if: \$\{\{ vars\.RCLONE_MOUNTS != '' \}\}/);
  assert.match(workflow, /- name: Stage Rclone mounts\n\s+if: \$\{\{ vars\.RCLONE_MOUNTS != '' \}\}/);
  assert.match(workflow, /RCLONE_CONFIG: \$\{\{ secrets\.RCLONE_CONFIG \}\}/);
  assert.match(workflow, /RCLONE_MOUNTS: \$\{\{ vars\.RCLONE_MOUNTS \}\}/);
  assert.match(workflow, /--rclone-config-file "\$RUNNER_TEMP\/rclone\.conf"/);
  assert.match(workflow, /--rclone-mounts-file "\$RUNNER_TEMP\/rclone-mounts"/);
  assert.match(workflow, /- name: Prepare FUSE for Rclone mounts/);
  assert.match(workflow, /grep -qx 'user_allow_other' \/etc\/fuse\.conf/);
});

test("CL-01 removes all staged sensitive and configuration files", () => {
  assert.match(workflow, /"\$RUNNER_TEMP\/session-credential"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/sensitive-facts"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/rclone\.conf"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/rclone-mounts"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/database\.json"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/database-ca\.pem"/);
});
