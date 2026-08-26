import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflowPath = new URL(
  "../.github/workflows/tsvc.yml",
  import.meta.url,
);

test("WF-01 workflow exposes only the closed Service input", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /^run-name: service:\$\{\{ inputs\.service \}\}$/m);
  assert.match(workflow, /^on:\n  workflow_dispatch:\n/m);
  assert.match(
    workflow,
    /service:\n\s+description: Service\n\s+required: true\n\s+type: choice\n\s+options:\n\s+- chrome\n\s+- motrix\n\s+- openlist/,
  );
  assert.doesNotMatch(workflow, /\bslot:|Session Slot|inputs\.slot/);
  assert.doesNotMatch(workflow, /schedule:|push:|pull_request:/);
});

test("WF-01 invalid raw dispatch values fail in the secret-free first step", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const match = workflow.match(
    /steps:\n\s+- name: Validate closed inputs\n\s+env:[\s\S]*?run: \|\n([\s\S]*?)\n\s+- name: Validate Motrix upload configuration/,
  );
  assert.ok(match?.[1], "validation step must remain statically inspectable");
  const script = match[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");

  assert.doesNotMatch(match[0], /secrets\.|SESSION_PASSWORD/);

  for (const service of ["chrome", "motrix", "openlist"]) {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      env: { ...process.env, INPUT_SERVICE: service },
    });
    assert.equal(result.status, 0, result.stderr.toString());
  }

  for (const service of ["shell", ""]) {
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      env: { ...process.env, INPUT_SERVICE: service },
    });
    assert.notEqual(result.status, 0, `${service} must fail closed`);
  }
});

test("WF-03 validates and stages a controlled destination manifest before checkout", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const match = workflow.match(
    /- name: Validate Motrix upload configuration\n[\s\S]*?run: \|\n([\s\S]*?)\n\s+- name: Validate database configuration/,
  );
  assert.ok(match?.[1], "rclone validation step must remain statically inspectable");
  const script = match[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");

  /** @param {string} service @param {string} configured @param {string} destinations */
  function validate(service, configured, destinations) {
    const directory = mkdtempSync(join(tmpdir(), "workflow-rclone-targets-"));
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      env: {
        ...process.env,
        INPUT_SERVICE: service,
        RCLONE_CONFIG_CONFIGURED: configured,
        RCLONE_DESTINATIONS: destinations,
        RUNNER_TEMP: directory,
      },
    });
    const staged = result.status === 0 && service === "motrix"
      ? readFileSync(join(directory, "rclone-destinations.json"), "utf8")
      : undefined;
    rmSync(directory, { recursive: true });
    return { result, staged };
  }

  assert.equal(validate("chrome", "false", "").result.status, 0);
  assert.equal(validate("openlist", "false", "").result.status, 0);
  assert.equal(validate("chrome", "true", '[{"id":"ignored","destination":"archive:anywhere"}]').result.status, 0);
  const manifest = '[{"id":"drive","destination":"archive:motrix"},{"id":"backup","destination":"s3:bucket"}]';
  const valid = validate("motrix", "true", manifest);
  assert.equal(valid.result.status, 0, valid.result.stderr.toString());
  assert.equal(valid.staged, manifest);
  for (const [configured, destinations] of [
    ["false", ""],
    ["true", ""],
    ["false", '[{"id":"drive","destination":"archive:motrix"}]'],
    ["true", "not-json"],
    ["true", "[]"],
    ["true", '[{"id":"../drive","destination":"archive:motrix"}]'],
    ["true", '[{"id":"drive","localRoot":"/tmp","destination":"archive:motrix"}]'],
    ["true", '[{"id":"drive","destination":"archive:a"},{"id":"drive","destination":"archive:b"}]'],
    ["true", '[{"id":"drive","destination":"/tmp/local"}]'],
    ["true", '[{"id":"drive","destination":":s3,provider=AWS:bucket"}]'],
  ]) {
    assert.notEqual(
      validate("motrix", configured ?? "", destinations ?? "").result.status,
      0,
      `${configured}/${JSON.stringify(destinations)} must fail closed`,
    );
  }

  const validationEnd = workflow.indexOf("- name: Validate database configuration");
  const checkout = workflow.indexOf("- name: Check out repository implementation");
  assert.ok(validationEnd > 0 && checkout > validationEnd);
});

test("WF-04 requires both database Secrets before checkout", () => {
  const workflow = readFileSync(workflowPath, "utf8");
  const match = workflow.match(
    /- name: Validate database configuration\n[\s\S]*?run: \|\n([\s\S]*?)\n\s+- name: Record Session start/,
  );
  assert.ok(match?.[1], "database validation must remain statically inspectable");
  const script = match[1].split("\n").map((line) => line.slice(10)).join("\n");
  /** @param {string} service @param {string} database @param {string} ca */
  function validate(service, database, ca) {
    return spawnSync("bash", ["-euo", "pipefail", "-c", script], {
      env: {
        ...process.env,
        INPUT_SERVICE: service,
        DATABASE_CONFIGURED: database,
        DATABASE_CA_CONFIGURED: ca,
      },
    });
  }

  assert.equal(validate("chrome", "false", "false").status, 0);
  assert.equal(validate("motrix", "false", "false").status, 0);
  assert.equal(validate("openlist", "true", "true").status, 0);
  /** @type {[string, string][]} */
  const incomplete = [["false", "false"], ["true", "false"], ["false", "true"]];
  for (const configured of incomplete) {
    assert.notEqual(validate("openlist", configured[0], configured[1]).status, 0);
  }
  assert.ok(workflow.indexOf("- name: Validate database configuration") < workflow.indexOf("- name: Check out repository implementation"));
});

test("WF-01 workflow pins its immutable execution policy", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.equal([...workflow.matchAll(/^  [a-z][a-z-]*:\n/gm)].length, 1);
  assert.doesNotMatch(workflow, /^\s+needs:/m);
  assert.match(
    workflow,
    /concurrency:\n\s+group: \$\{\{ inputs\.service == 'openlist' && 'tsvc-serialized' \|\| format\('tsvc-quick-\{0\}', github\.run_id\) \}\}\n\s+cancel-in-progress: false/,
  );
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.match(workflow, /timeout-minutes: 330/);
  assert.doesNotMatch(workflow, /^\s*environment:|deployment:/m);
  const chromeCredentialStep = workflow.match(
    /- name: Stage Session Credential\n([\s\S]*?)\n\s+- name: Stage Motrix Operator Token/,
  )?.[1] ?? "";
  const motrixCredentialStep = workflow.match(
    /- name: Stage Motrix Operator Token\n([\s\S]*?)\n\s+- name: Stage Rclone configuration/,
  )?.[1] ?? "";
  assert.match(chromeCredentialStep, /if: \$\{\{ inputs\.service == 'chrome' \|\| inputs\.service == 'openlist' \}\}/);
  assert.match(chromeCredentialStep, /SESSION_PASSWORD: \$\{\{ secrets\.SESSION_PASSWORD \}\}/);
  assert.doesNotMatch(chromeCredentialStep, /MOTRIX_OPERATOR_TOKEN/);
  assert.match(motrixCredentialStep, /if: \$\{\{ inputs\.service == 'motrix' \}\}/);
  assert.match(motrixCredentialStep, /SESSION_PASSWORD: \$\{\{ secrets\.SESSION_PASSWORD \}\}/);
  assert.doesNotMatch(motrixCredentialStep, /MOTRIX_OPERATOR_TOKEN/);
  assert.match(workflow, /credential_file="\$RUNNER_TEMP\/session-credential"/);
  assert.match(workflow, /if \[\[ "\$INPUT_SERVICE" == "motrix" \]\]; then\n\s+credential_file="\$RUNNER_TEMP\/motrix-operator-token"/);
  assert.match(workflow, /--credential-file "\$credential_file"/);
  assert.match(workflow, /--sensitive-facts-file "\$RUNNER_TEMP\/sensitive-facts"/);
  assert.match(workflow, /RCLONE_CONFIG_CONFIGURED: \$\{\{ secrets\.RCLONE_CONFIG != '' \}\}/);
  assert.match(workflow, /RCLONE_CONFIG: \$\{\{ secrets\.RCLONE_CONFIG \}\}/);
  assert.match(workflow, /RCLONE_DESTINATIONS: \$\{\{ vars\.RCLONE_DESTINATIONS \}\}/);
  assert.doesNotMatch(workflow, /vars\.RCLONE_DESTINATION(?:\s|\}|$)/);
  assert.match(workflow, /--rclone-destinations-file "\$RUNNER_TEMP\/rclone-destinations\.json"/);
  assert.match(workflow, /DATABASE_CONFIGURED: \$\{\{ secrets\.DATABASE != '' \}\}/);
  assert.match(workflow, /DATABASE_CA_CONFIGURED: \$\{\{ secrets\.DATABASE_CA != '' \}\}/);
  assert.match(workflow, /DATABASE: \$\{\{ secrets\.DATABASE \}\}/);
  assert.match(workflow, /DATABASE_CA: \$\{\{ secrets\.DATABASE_CA \}\}/);
  assert.match(workflow, /--database-file "\$RUNNER_TEMP\/database\.json"/);
  assert.match(workflow, /--database-ca-file "\$RUNNER_TEMP\/database-ca\.pem"/);
  assert.doesNotMatch(workflow, /OPENLIST_DATABASE|--openlist-database/);
  assert.match(
    workflow,
    /rclone\/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548/,
  );
  assert.doesNotMatch(workflow, /CLOUDFLARE_TUNNEL_TOKEN|CLOUDFLARE_TUNNEL_URL|named-tunnel|tunnel-mode/);
  assert.match(workflow, /permissions:\n\s+contents: read/);
  assert.match(
    workflow,
    /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683/,
  );
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /lfs: false/);
  assert.match(workflow, /submodules: false/);
  assert.match(workflow, /if: \$\{\{ always\(\) \}\}/);
  assert.match(workflow, /"\$RUNNER_TEMP\/rclone\.conf"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/rclone-destinations\.json"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/database\.json"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/database-ca\.pem"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/session-credential" \\\n\s+"\$RUNNER_TEMP\/motrix-operator-token"/);
  assert.match(workflow, /"\$RUNNER_TEMP\/sensitive-facts"/);
  assert.doesNotMatch(workflow, /secrets\.MOTRIX_OPERATOR_TOKEN/);

  const uses = [...workflow.matchAll(/uses:\s+([^\s]+)/g)].map((entry) => entry[1]);
  assert.deepEqual(uses, [
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  ]);
  assert.match(workflow, /setsid "\$RUNNER_TEMP\/session-wrapper\.sh"/);
  assert.match(
    workflow,
    /name: session-deck-locators\n\s+path: session-deck-output\.md\n\s+if-no-files-found: error\n\s+retention-days: 1/,
  );
  assert.match(workflow, /if: \$\{\{ always\(\) && steps\.session\.outcome == 'success' \}\}/);
  assert.match(workflow, /scripts\/reap-session\.sh "\$session_pid" 0/);
  assert.match(workflow, /scripts\/reap-session\.sh "\$\(cat "\$RUNNER_TEMP\/session\.pid"\)" 5/);
  const waitStep = workflow.match(
    /- name: Wait for Session\n[\s\S]*?run: \|\n([\s\S]*?)\n\s+- name: Record pre-readiness failure/,
  )?.[1] ?? "";
  assert.match(waitStep, /interrupt\(\) \{\n\s+kill "\$tail_pid"[\s\S]*?exit 143\n\s+\}/);
  assert.doesNotMatch(waitStep, /interrupt\(\) \{[^}]*while kill -0/);
  assert.doesNotMatch(workflow, /npm ci|upload-locator-artifact|ACTIONS_RUNTIME_TOKEN|@actions\/artifact/);
});
