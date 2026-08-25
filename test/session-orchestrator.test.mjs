import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync, symlinkSync, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const credential = "E".repeat(43);
const basic = `Basic ${Buffer.from(`session:${credential}`).toString("base64")}`;

/** @param {import("node:http").IncomingMessage} request @param {import("node:http").ServerResponse} response */
function handler(request, response) {
  if (request.url === "/" && request.headers.authorization === basic) {
    response.writeHead(200).end("chrome");
  } else {
    response.writeHead(401).end();
  }
}

/** @param {import("node:http").IncomingMessage} request @param {import("node:stream").Duplex} socket */
function upgrade(request, socket) {
  if (request.url === "/websocket" && request.headers.authorization === basic) {
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  } else {
    socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  }
}

/** @param {import("node:net").Server} server @param {number} port */
function listen(server, port) {
  /** @type {Promise<void>} */
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(undefined));
  });
}

/** @param {import("node:net").Server} server */
function close(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)));
}

/** @param {() => boolean} predicate @param {number} [timeout] */
async function waitUntil(predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("condition did not become true");
}

test("RD-01 writes the Session Address only under ## Locators", () => {
  const source = readFileSync(new URL("../src/session.mjs", import.meta.url), "utf8");
  const ready = source.slice(source.indexOf("function writeReadySummary"), source.indexOf("function locatorBlock"));
  assert.match(ready, /locatorBlock\(address\)/);
  assert.doesNotMatch(ready, /`- Session Address:/);
  assert.match(source, /function locatorBlock[\s\S]*## Locators[\s\S]*Session Address: \$\{address\}/);
  assert.match(source, /console\.log\(locatorBlock\(sessionAddress\)/);
});

test("RD-01 gates the Session Address and reduces a later failure Summary", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-orchestrator-"));
  const bin = join(root, "bin");
  const credentialFile = join(root, "session-credential");
  const summary = join(root, "summary");
  const dockerLog = join(root, "docker.log");
  const cloudflaredArguments = join(root, "cloudflared-arguments");
  const started = join(root, "started");
  const key = join(root, "key.pem");
  const certificate = join(root, "certificate.pem");
  mkdirSync(bin);
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(started, `${Math.floor(Date.now() / 1000)}\n`);
  const openssl = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=session-test.trycloudflare.com",
    "-addext", "subjectAltName=DNS:session-test.trycloudflare.com",
    "-keyout", key, "-out", certificate,
  ]);
  assert.equal(openssl.status, 0, openssl.stderr.toString());

  const docker = new URL("./fixtures/fake-docker", import.meta.url).pathname;
  const cloudflaredFixture = new URL("./fixtures/fake-cloudflared", import.meta.url).pathname;
  const cloudflared = join(root, "cloudflared");
  copyFileSync(cloudflaredFixture, cloudflared);
  chmodSync(docker, 0o755);
  chmodSync(cloudflared, 0o755);
  symlinkSync(docker, join(bin, "docker"));

  const local = createServer(handler);
  local.on("upgrade", upgrade);
  const publicServer = createSecureServer({ key: readFileSync(key), cert: readFileSync(certificate) }, handler);
  publicServer.on("upgrade", upgrade);
  await listen(local, 58080);
  await listen(publicServer, 0);
  const address = publicServer.address();
  assert.ok(address && typeof address === "object");

  const child = spawn(process.execPath, [
    new URL("../src/session.mjs", import.meta.url).pathname,
    "--service", "chrome",
    "--credential-file", credentialFile,
    "--cloudflared", cloudflared,
    "--started-epoch-file", started,
  ], {
    env: {
      ...process.env,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_CLOUDFLARED_ARGUMENTS: cloudflaredArguments,
      FAKE_SESSION_ADDRESS: `https://session-test.trycloudflare.com:${address.port}`,
      GITHUB_STEP_SUMMARY: summary,
      NODE_OPTIONS: `--require=${new URL("./fixtures/force-localhost.cjs", import.meta.url).pathname}`,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    assert.throws(() => readFileSync(summary), { code: "ENOENT" });
    await waitUntil(() => {
      try { return readFileSync(summary, "utf8").includes("## Session Ready") || child.exitCode !== null; }
      catch { return child.exitCode !== null; }
    });
    assert.equal(child.exitCode, null, output);
    assert.deepEqual(JSON.parse(readFileSync(cloudflaredArguments, "utf8")), [
      "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:49312",
      "--url", "http://127.0.0.1:58080",
    ]);
    assert.match(output, /Session Address: https:\/\/session-test\.trycloudflare\.com/);
    assert.match(output, /## Locators/);
    const readySummary = readFileSync(summary, "utf8");
    assert.match(readySummary, /## Locators\n\n- Session Address: https:\/\/session-test\.trycloudflare\.com/);
    assert.doesNotMatch(readySummary.split("## Locators")[1] ?? "", /Access:/);
    assert.equal(readySummary.match(/https:\/\/session-test\.trycloudflare\.com/g)?.length, 1);
    assert.doesNotMatch(readySummary, new RegExp(credential));
    writeFileSync(`${dockerLog}.stopped`, "stopped");
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 1, output);
    const failureSummary = readFileSync(summary, "utf8");
    assert.match(failureSummary, /^## Session failed/);
    assert.match(failureSummary, /Phase: runtime/);
    assert.doesNotMatch(failureSummary, /https?:\/\//);
    assert.doesNotMatch(failureSummary, /Service:|Expected expiry:|Access:/);
    const dockerCommands = readFileSync(dockerLog, "utf8");
    assert.match(dockerCommands, /"rm"/);
    assert.match(dockerCommands, /"volume","rm"/);
    assert.doesNotMatch(`${output}${dockerCommands}${readySummary}${failureSummary}`, new RegExp(credential));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await close(local);
    await close(publicServer);
    rmSync(root, { recursive: true });
  }
});

test("UP-02 starts Motrix uploads when public validation is challenged", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-upload-failure-"));
  const bin = join(root, "bin");
  const credentialFile = join(root, "session-credential");
  const summary = join(root, "summary");
  const dockerLog = join(root, "docker.log");
  const cloudflaredArguments = join(root, "cloudflared-arguments");
  const started = join(root, "started");
  const rcloneConfig = join(root, "rclone.conf");
  const rcloneDestinations = join(root, "rclone-destinations.json");
  const cloudflared = join(root, "cloudflared");
  const key = join(root, "key.pem");
  const certificate = join(root, "certificate.pem");
  mkdirSync(bin);
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(started, `${Math.floor(Date.now() / 1000)}\n`);
  writeFileSync(rcloneConfig, "[archive]\ntype = memory\n", { mode: 0o600 });
  writeFileSync(rcloneDestinations, '[{"id":"drive","destination":"archive:motrix"}]', { mode: 0o600 });
  writeFileSync(`${dockerLog}.rclone-failures`, "10");
  const openssl = spawnSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=session-test.trycloudflare.com",
    "-addext", "subjectAltName=DNS:session-test.trycloudflare.com",
    "-keyout", key, "-out", certificate,
  ]);
  assert.equal(openssl.status, 0, openssl.stderr.toString());
  const docker = new URL("./fixtures/fake-docker", import.meta.url).pathname;
  copyFileSync(new URL("./fixtures/fake-cloudflared", import.meta.url).pathname, cloudflared);
  chmodSync(docker, 0o755);
  chmodSync(cloudflared, 0o755);
  symlinkSync(docker, join(bin, "docker"));

  const bearer = `Bearer ${credential}`;
  const motrixHandler = (
    /** @type {import("node:http").IncomingMessage} */ request,
    /** @type {import("node:http").ServerResponse} */ response,
  ) => {
    if (request.url === "/healthz") response.writeHead(200).end('{"ok":true}');
    else if (
      request.method === "POST" && request.url === "/rpc/query/query%3AlistTasks" &&
      request.headers.authorization === bearer
    ) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{
        id: "failed-task",
        status: "completed",
        transitionPhase: "idle",
        finalPath: "/downloads/drive/file.bin",
      }]));
    } else response.writeHead(401).end();
  };
  const motrixUpgrade = (
    /** @type {import("node:http").IncomingMessage} */ request,
    /** @type {import("node:stream").Duplex} */ socket,
  ) => {
    if (request.url === "/rpc/events" && request.headers.authorization === bearer) {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    } else socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  };
  const local = createServer(motrixHandler);
  local.on("upgrade", motrixUpgrade);
  const publicServer = createSecureServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (_request, response) => {
      response.writeHead(403, { "cf-mitigated": "challenge" }).end("challenge");
    },
  );
  await listen(local, 58081);
  await listen(publicServer, 0);
  const address = publicServer.address();
  assert.ok(address && typeof address === "object");

  const child = spawn(process.execPath, [
    new URL("../src/session.mjs", import.meta.url).pathname,
    "--service", "motrix",
    "--credential-file", credentialFile,
    "--cloudflared", cloudflared,
    "--started-epoch-file", started,
    "--rclone-config-file", rcloneConfig,
    "--rclone-destinations-file", rcloneDestinations,
  ], {
    env: {
      ...process.env,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_CLOUDFLARED_ARGUMENTS: cloudflaredArguments,
      FAKE_SESSION_ADDRESS: `https://session-test.trycloudflare.com:${address.port}`,
      GITHUB_STEP_SUMMARY: summary,
      NODE_OPTIONS: `--require=${new URL("./fixtures/force-localhost.cjs", import.meta.url).pathname}`,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    await waitUntil(() => /Rclone upload failed \(item 1, destination drive, attempt 1, category unknown, exit 1\); retry scheduled/.test(output) || child.exitCode !== null);
    assert.equal(child.exitCode, null, output);
    assert.deepEqual(JSON.parse(readFileSync(cloudflaredArguments, "utf8")), [
      "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:49312",
      "--url", "http://127.0.0.1:58081",
    ]);
    child.kill("SIGTERM");
    const exitCode = await new Promise((resolve) => child.once("exit", resolve));
    assert.equal(exitCode, 1, output);
    const failureSummary = readFileSync(summary, "utf8");
    assert.match(failureSummary, /Motrix upload or task cleanup remained incomplete\./);
    assert.doesNotMatch(failureSummary, /https?:\/\//);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await close(local);
    await close(publicServer);
    rmSync(root, { recursive: true });
  }
});

test("RD-01 publishes no Session Address when Tunnel startup fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-orchestrator-failure-"));
  const credentialFile = join(root, "session-credential");
  const summary = join(root, "summary");
  const started = join(root, "started");
  const cloudflared = join(root, "cloudflared");
  const rcloneConfig = join(root, "rclone.conf");
  const rcloneDestinations = join(root, "rclone-destinations.json");
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(started, `${Math.floor(Date.now() / 1000)}\n`);
  writeFileSync(rcloneConfig, "[archive]\ntype = memory\n", { mode: 0o600 });
  writeFileSync(rcloneDestinations, '[{"id":"drive","destination":"archive:motrix"}]', { mode: 0o600 });
  copyFileSync(new URL("./fixtures/fake-cloudflared", import.meta.url).pathname, cloudflared);
  chmodSync(cloudflared, 0o755);

  const result = spawnSync(process.execPath, [
    new URL("../src/session.mjs", import.meta.url).pathname,
    "--service", "motrix",
    "--credential-file", credentialFile,
    "--cloudflared", cloudflared,
    "--started-epoch-file", started,
    "--rclone-config-file", rcloneConfig,
    "--rclone-destinations-file", rcloneDestinations,
  ], {
    env: {
      ...process.env,
      FAKE_SESSION_ADDRESS: "https://not-a-quick-tunnel.example",
      FAKE_LOG_BYTES: String(35 * 1024 * 1024),
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: root,
    },
  });

  try {
    assert.equal(result.status, 1, result.stdout.toString());
    const failureSummary = readFileSync(summary, "utf8");
    assert.match(failureSummary, /Phase: startup/);
    assert.doesNotMatch(failureSummary, /https?:\/\//);
    assert.doesNotMatch(`${result.stdout}${result.stderr}${failureSummary}`, new RegExp(credential));
    assert.throws(() => readFileSync(credentialFile), { code: "ENOENT" });
    assert.throws(() => readFileSync(rcloneConfig), { code: "ENOENT" });
    assert.throws(() => readFileSync(rcloneDestinations), { code: "ENOENT" });
    const boundedLogs = readdirSync(root).filter((name) => name.startsWith("cloudflared.log"));
    assert.equal(boundedLogs.length, 3);
    for (const name of boundedLogs) {
      assert.ok(statSync(join(root, name)).size <= 10 * 1024 * 1024);
      assert.doesNotMatch(readFileSync(join(root, name), "utf8"), new RegExp(credential));
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("FL-01 preserves a selected-Service startup diagnostic", () => {
  const root = mkdtempSync(join(tmpdir(), "session-orchestrator-service-failure-"));
  const bin = join(root, "bin");
  const credentialFile = join(root, "session-credential");
  const summary = join(root, "summary");
  const dockerLog = join(root, "docker.log");
  const started = join(root, "started");
  const cloudflared = join(root, "cloudflared");
  const rcloneConfig = join(root, "rclone.conf");
  const rcloneDestinations = join(root, "rclone-destinations.json");
  mkdirSync(bin);
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(started, `${Math.floor(Date.now() / 1000)}\n`);
  writeFileSync(rcloneConfig, "[archive]\ntype = memory\n", { mode: 0o600 });
  writeFileSync(rcloneDestinations, '[{"id":"drive","destination":"missing:motrix"}]', { mode: 0o600 });
  const docker = new URL("./fixtures/fake-docker", import.meta.url).pathname;
  copyFileSync(new URL("./fixtures/fake-cloudflared", import.meta.url).pathname, cloudflared);
  chmodSync(docker, 0o755);
  chmodSync(cloudflared, 0o755);
  symlinkSync(docker, join(bin, "docker"));

  const result = spawnSync(process.execPath, [
    new URL("../src/session.mjs", import.meta.url).pathname,
    "--service", "motrix",
    "--credential-file", credentialFile,
    "--cloudflared", cloudflared,
    "--started-epoch-file", started,
    "--rclone-config-file", rcloneConfig,
    "--rclone-destinations-file", rcloneDestinations,
  ], {
    env: {
      ...process.env,
      FAKE_DOCKER_LOG: dockerLog,
      FAKE_SESSION_ADDRESS: "session-test.trycloudflare.com",
      GITHUB_STEP_SUMMARY: summary,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: root,
    },
  });

  try {
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 1, output);
    assert.match(output, /Rclone Destination remote is not configured\./);
    assert.doesNotMatch(output, /^Session failed\.$/m);
    assert.match(readFileSync(summary, "utf8"), /Diagnostic: Rclone Destination remote is not configured\./);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("WF-03 rejects a Motrix Session without its required upload configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "session-orchestrator-rclone-arguments-"));
  const credentialFile = join(root, "session-credential");
  const started = join(root, "started");
  const cloudflared = join(root, "cloudflared");
  const summary = join(root, "summary");
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(started, `${Math.floor(Date.now() / 1000)}\n`);
  copyFileSync(new URL("./fixtures/fake-cloudflared", import.meta.url).pathname, cloudflared);
  chmodSync(cloudflared, 0o755);

  const result = spawnSync(process.execPath, [
    new URL("../src/session.mjs", import.meta.url).pathname,
    "--service", "motrix",
    "--credential-file", credentialFile,
    "--cloudflared", cloudflared,
    "--started-epoch-file", started,
  ], {
    env: { ...process.env, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root },
  });

  try {
    assert.equal(result.status, 1);
    assert.match(readFileSync(summary, "utf8"), /Session arguments are invalid\./);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("WF-04 rejects an OpenList Session without both database files", () => {
  const root = mkdtempSync(join(tmpdir(), "session-orchestrator-openlist-arguments-"));
  const credentialFile = join(root, "session-credential");
  const started = join(root, "started");
  const cloudflared = join(root, "cloudflared");
  const summary = join(root, "summary");
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(started, `${Math.floor(Date.now() / 1000)}\n`);
  copyFileSync(new URL("./fixtures/fake-cloudflared", import.meta.url).pathname, cloudflared);
  chmodSync(cloudflared, 0o755);

  const base = [
    new URL("../src/session.mjs", import.meta.url).pathname,
    "--service", "openlist",
    "--credential-file", credentialFile,
    "--cloudflared", cloudflared,
    "--started-epoch-file", started,
  ];
  try {
    for (const extra of [
      [],
      ["--openlist-database-file", join(root, "database.json")],
      ["--openlist-database-ca-file", join(root, "database-ca.pem")],
    ]) {
      const result = spawnSync(process.execPath, [...base, ...extra], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root },
      });
      assert.equal(result.status, 1);
      assert.match(readFileSync(summary, "utf8"), /Session arguments are invalid\./);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("RD-01 accepts cloudflared's bare Quick Tunnel hostname", () => {
  const root = mkdtempSync(join(tmpdir(), "session-orchestrator-hostname-"));
  const credentialFile = join(root, "session-credential");
  const summary = join(root, "summary");
  const started = join(root, "started");
  const cloudflared = join(root, "cloudflared");
  writeFileSync(credentialFile, "", { mode: 0o600 });
  writeFileSync(started, `${Math.floor(Date.now() / 1000)}\n`);
  copyFileSync(new URL("./fixtures/fake-cloudflared", import.meta.url).pathname, cloudflared);
  chmodSync(cloudflared, 0o755);

  const result = spawnSync(process.execPath, [
    new URL("../src/session.mjs", import.meta.url).pathname,
    "--service", "chrome",
    "--credential-file", credentialFile,
    "--cloudflared", cloudflared,
    "--started-epoch-file", started,
  ], {
    env: {
      ...process.env,
      FAKE_SESSION_ADDRESS: "session-test.trycloudflare.com",
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: root,
    },
  });

  try {
    assert.equal(result.status, 1, result.stdout.toString());
    const failureSummary = readFileSync(summary, "utf8");
    assert.match(failureSummary, /Diagnostic: Selected Service credential file is invalid\./);
    assert.doesNotMatch(failureSummary, /invalid Session Address/);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("WF-01 rejects removed workflow arguments", () => {
  const root = mkdtempSync(join(tmpdir(), "session-orchestrator-arguments-"));
  const summary = join(root, "summary");
  const base = [
    new URL("../src/session.mjs", import.meta.url).pathname,
    "--service", "chrome",
    "--credential-file", join(root, "session-credential"),
    "--cloudflared", join(root, "cloudflared"),
    "--started-epoch-file", join(root, "started"),
  ];

  try {
    for (const removedArgument of [
      ["--slot", "slot-1"],
      ["--named-tunnel-token-file", join(root, "token")],
      ["--named-tunnel-url", "https://session.example.com"],
    ]) {
      const result = spawnSync(process.execPath, [...base, ...removedArgument], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary, RUNNER_TEMP: root },
      });
      assert.equal(result.status, 1);
      assert.match(readFileSync(summary, "utf8"), /Session arguments are invalid\./);
    }
  } finally {
    rmSync(root, { recursive: true });
  }
});
