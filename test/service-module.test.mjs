import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statfsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSelectedService } from "../src/service-module.mjs";

const credential = "S".repeat(43);
const chromeImage = "lscr.io/linuxserver/chrome@sha256:49a019a04b8d38422609d3c586636293417f61886704d516b7d5233cb4bd0b12";
const motrixImage = "ghcr.io/agalwood/motrix-server@sha256:d3ecb7e7233d25ca1e947a386ee7c885f8c61fbabf7af4754a65d9d7fbdefa6f";
const openlistImage = "openlistteam/openlist@sha256:b4de1e8e07de352a57e8f9eefbe5525c4a6eeef0ae4c74c2a1e68cb71d185fdb";
const rcloneImage = "rclone/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548";
const rcloneConfig = "[archive]\ntype = memory\nsecret = rclone_config_secret\n[backup]\ntype = memory\n";
const destinations = [
  { id: "drive", localRoot: "/downloads/drive", destination: "archive:motrix" },
  { id: "backup", localRoot: "/downloads/backup", destination: "backup:copies" },
];

/** @typedef {"chrome" | "motrix" | "openlist"} Service */

/** @param {Service} service */
function serviceOrigin(service) {
  return `http://127.0.0.1:${service === "chrome" ? 58080 : service === "motrix" ? 58081 : 58082}`;
}

/** @param {Service} service @param {{ healthy: boolean, tasks: unknown[], commands: { channel: string, args: unknown[] }[], cleanupFailures: number }} health */
function startServiceServer(service, health) {
  const basic = `Basic ${Buffer.from(`session:${credential}`).toString("base64")}`;
  const bearer = `Bearer ${credential}`;
  const server = createServer((request, response) => {
    if (!health.healthy) {
      response.writeHead(503).end();
      return;
    }
    if (request.url === "/healthz") {
      response.writeHead(200).end('{"ok":true}');
      return;
    }
    if (service === "openlist" && request.url === "/") {
      response.writeHead(200).end("openlist");
      return;
    }
    if (service === "openlist" && request.method === "POST" && request.url === "/api/auth/login") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        if (payload.username === "admin" && payload.password === credential) {
          response.writeHead(200, { "content-type": "application/json" })
            .end('{"code":200,"data":{"token":"test-token"}}');
        } else response.writeHead(401).end('{"code":401}');
      });
      return;
    }
    if (service === "chrome" && request.url === "/" && request.headers.authorization === basic) {
      response.writeHead(200).end("chrome");
      return;
    }
    if (
      service === "motrix" &&
      request.method === "POST" &&
      request.url === "/rpc/query/query%3AlistTasks" &&
      request.headers.authorization === bearer
    ) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(health.tasks));
      return;
    }
    if (
      service === "motrix" && request.method === "POST" &&
      request.url?.startsWith("/rpc/command/") && request.headers.authorization === bearer
    ) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        health.commands.push({
          channel: decodeURIComponent(request.url?.slice("/rpc/command/".length) ?? ""),
          args: payload.args,
        });
        if (health.cleanupFailures > 0) {
          health.cleanupFailures -= 1;
          response.writeHead(500).end('{"error":"injected"}');
        } else response.writeHead(200).end('{"ok":true}');
      });
      return;
    }
    response.writeHead(401).end();
  });
  server.on("upgrade", (request, socket) => {
    if (!health.healthy) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    const expectedPath = service === "chrome" ? "/websocket" : "/rpc/events";
    const expectedAuth = service === "chrome" ? basic : bearer;
    if (request.url === expectedPath && request.headers.authorization === expectedAuth) {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    } else {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(service === "chrome" ? 58080 : service === "motrix" ? 58081 : 58082, "127.0.0.1", () => resolve(server));
  });
}

/**
 * @param {Service} service
 * @param {"cancel" | "exit" | "unhealthy"} [termination]
 * @param {(context: { health: { healthy: boolean, tasks: unknown[], commands: { channel: string, args: unknown[] }[], cleanupFailures: number }, dockerLog: string, output: string[] }) => Promise<void>} [onReady]
 */
async function exerciseAdapter(service, termination = "cancel", onReady) {
  const root = mkdtempSync(join(tmpdir(), `service-module-${service}-`));
  const bin = join(root, "bin");
  const credentialFile = join(root, "session-credential");
  const rcloneConfigFile = join(root, "rclone.conf");
  const databaseFile = join(root, "database.json");
  const databaseCaFile = join(root, "database-ca.pem");
  const dockerLog = join(root, "docker.log");
  const fixture = new URL("./fixtures/fake-docker", import.meta.url).pathname;
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  if (service === "motrix") writeFileSync(rcloneConfigFile, rcloneConfig, { mode: 0o600 });
  if (service === "openlist") {
    writeFileSync(databaseFile, JSON.stringify({
      host: "mysql.internal.example",
      port: 3306,
      user: "openlist",
      password: "database_secret_value",
    }), { mode: 0o600 });
    const key = join(root, "database-ca-key.pem");
    const generated = spawnSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=OpenList Database CA", "-keyout", key, "-out", databaseCaFile,
    ]);
    assert.equal(generated.status, 0, generated.stderr.toString());
    chmodSync(databaseCaFile, 0o600);
  }
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  chmodSync(fixture, 0o755);
  symlinkSync(fixture, join(bin, "docker"));

  const previous = {
    dockerLog: process.env.FAKE_DOCKER_LOG,
    path: process.env.PATH,
    runnerTemp: process.env.RUNNER_TEMP,
  };
  process.env.FAKE_DOCKER_LOG = dockerLog;
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.RUNNER_TEMP = root;
  const health = { healthy: true, tasks: [], commands: [], cleanupFailures: 0 };
  const server = await startServiceServer(service, health);
  const cancellation = new AbortController();
  /** @type {string[]} */
  const output = [];
  const previousConsoleLog = console.log;
  let serviceRun;

  try {
    console.log = (...values) => { output.push(values.join(" ")); };
    serviceRun = runSelectedService({
      service,
      sessionAddress: serviceOrigin(service),
      credentialFile: credentialFile,
      cancellation: cancellation.signal,
      ...(service === "motrix"
        ? { upload: { rcloneConfigFile, destinations } }
        : {}),
      ...(service === "openlist"
        ? { database: { file: databaseFile, caFile: databaseCaFile } }
        : {}),
    });
    const ready = await serviceRun.ready;
    assert.match(
      ready.accessGuidance,
      service === "chrome" ? /Session Credential/ : service === "motrix" ? /Motrix Operator Token/ : /OpenList.*admin.*Session Credential/,
    );
    if (onReady) await onReady({ health, dockerLog, output });
    if (termination === "cancel") cancellation.abort();
    else if (termination === "exit") writeFileSync(`${dockerLog}.stopped`, "stopped");
    else health.healthy = false;
    const result = await serviceRun.finished;
    assert.throws(() => statSync(credentialFile), { code: "ENOENT" });
    if (service === "motrix") assert.throws(() => statSync(rcloneConfigFile), { code: "ENOENT" });
    if (service === "openlist") {
      assert.throws(() => statSync(databaseFile), { code: "ENOENT" });
      assert.throws(() => statSync(databaseCaFile), { code: "ENOENT" });
    }

    const commands = readFileSync(dockerLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { commands, motrixCommands: health.commands, output, result, root };
  } finally {
    console.log = previousConsoleLog;
    cancellation.abort();
    if (serviceRun) await serviceRun.finished;
    await new Promise((resolve) => server.close(resolve));
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.runnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous.runnerTemp;
    if (previous.dockerLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = previous.dockerLog;
  }
}

/** @param {() => boolean} predicate @param {number} [timeout] */
async function waitUntil(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not become true");
}

test("AU-01 and IS-01 Chrome uses native file-backed authentication and one confined Origin", async () => {
  const { commands, root } = await exerciseAdapter("chrome");
  const run = commands.find((command) => command[0] === "run" && command.includes("--detach"));
  assert.ok(run);
  assert.ok(run.includes(chromeImage));
  assert.ok(run.includes("127.0.0.1:58080:3000"));
  assert.equal(run.filter((/** @type {string} */ argument) => argument === "--publish").length, 1);
  assert.doesNotMatch(JSON.stringify(run), /58081/);
  assert.ok(run.includes("1g"));
  assert.ok(run.includes("START_DOCKER=false"));
  assert.ok(run.includes("CUSTOM_USER=session"));
  assert.ok(run.includes("FILE__PASSWORD=/run/secrets/session-credential"));
  assert.doesNotMatch(JSON.stringify(commands), new RegExp(credential));
  assert.doesNotMatch(JSON.stringify(run), /3001|8082|privileged|unconfined|docker\.sock/);
  rmSync(root, { recursive: true });
});

test("AU-03, IS-01, and PS-01 OpenList bootstraps a persistent database behind one confined Origin", async () => {
  const { commands, result, root } = await exerciseAdapter("openlist", "cancel", async ({ dockerLog }) => {
    const activeCommands = readFileSync(dockerLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const permission = activeCommands.find((command) =>
      command.some((/** @type {string} */ argument) => argument.endsWith("-openlist-permissions"))
    );
    const configMount = permission?.find((/** @type {string} */ argument) =>
      argument.includes("target=/run/secrets/openlist-config")
    );
    const configSource = configMount?.match(/(?:^|,)source=([^,]+),target=/)?.[1];
    assert.ok(configSource);
    const config = JSON.parse(readFileSync(configSource, "utf8"));
    assert.equal(config.database.name, "openlist");
  });
  const permission = commands.find((command) => command.some((/** @type {string} */ argument) => argument.endsWith("-openlist-permissions")));
  const configuration = commands.find((command) => command.some((/** @type {string} */ argument) => argument.endsWith("-openlist-configuration")));
  const bootstrap = commands.find((command) => command.some((/** @type {string} */ argument) => argument.endsWith("-openlist-bootstrap")));
  const run = commands.find((command) => command[0] === "run" && command.includes("--detach"));
  assert.ok(permission && configuration && bootstrap && run);
  assert.ok(commands.find((command) => command[0] === "pull")?.includes(openlistImage));
  assert.ok(commands.indexOf(permission) < commands.indexOf(configuration));
  assert.ok(commands.indexOf(configuration) < commands.indexOf(bootstrap));
  assert.ok(commands.indexOf(bootstrap) < commands.indexOf(run));
  assert.ok(permission.includes("CHOWN"));
  assert.ok(permission.some((/** @type {string} */ argument) => argument.includes("target=/run/secrets/session-credential")));
  assert.ok(permission.some((/** @type {string} */ argument) => argument.includes("target=/run/secrets/openlist-config")));
  assert.ok(permission.some((/** @type {string} */ argument) => argument.includes("target=/run/secrets/openlist-database-ca")));
  assert.ok(bootstrap.includes("1001:1001"));
  assert.ok(bootstrap.includes("SSL_CERT_FILE=/opt/openlist/data/database-ca.pem"));
  assert.ok(bootstrap.some((/** @type {string} */ argument) => argument.includes("OPENLIST_ADMIN_PASSWORD") && argument.includes("session-credential")));
  assert.ok(run.includes(openlistImage));
  assert.ok(run.includes("127.0.0.1:58082:5244"));
  assert.ok(run.includes("1001:1001"));
  assert.ok(run.includes("--read-only"));
  assert.ok(run.includes("ALL"));
  assert.ok(run.includes("no-new-privileges"));
  assert.ok(run.includes("RUN_ARIA2=true"));
  assert.ok(run.includes("SSL_CERT_FILE=/opt/openlist/data/database-ca.pem"));
  assert.equal(run.filter((/** @type {string} */ argument) => argument === "--publish").length, 1);
  assert.doesNotMatch(JSON.stringify(run), /5245|session-credential|OPENLIST_ADMIN_PASSWORD/);
  assert.doesNotMatch(JSON.stringify(commands), new RegExp(`${credential}|database_secret_value`));
  assert.deepEqual(result, { status: "success" });
  rmSync(root, { recursive: true });
});

test("FL-01 a selected-Service process exit fails without restart", async () => {
  const { commands, result, root } = await exerciseAdapter("chrome", "exit");
  assert.deepEqual(result, { phase: "runtime", summary: "Selected Service exited." });
  assert.equal(commands.filter((command) => command[0] === "run" && command.includes("--detach")).length, 1);
  rmSync(root, { recursive: true });
});

test("FL-01 continuous unhealthy state fails after 30 seconds without restart", { timeout: 40_000 }, async () => {
  const started = Date.now();
  const { commands, result, root } = await exerciseAdapter("chrome", "unhealthy");
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { phase: "runtime", summary: "A required Service health signal remained unhealthy." });
  assert.ok(elapsed >= 30_000 && elapsed < 36_000, `health failure took ${elapsed}ms`);
  assert.equal(commands.filter((command) => command[0] === "run" && command.includes("--detach")).length, 1);
  rmSync(root, { recursive: true });
});

test("DS-01 the single 2 GiB floor fails startup before the Service starts", {
  skip: statfsSync("/dev/shm").bavail * statfsSync("/dev/shm").bsize >= 2 * 1024 * 1024 * 1024,
}, async () => {
  const root = mkdtempSync("/dev/shm/service-disk-pressure-");
  const bin = join(root, "bin");
  const credentialFile = join(root, "session-credential");
  const dockerLog = join(root, "docker.log");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  symlinkSync(new URL("./fixtures/fake-docker", import.meta.url).pathname, join(bin, "docker"));
  const previous = { dockerLog: process.env.FAKE_DOCKER_LOG, path: process.env.PATH, runnerTemp: process.env.RUNNER_TEMP };
  process.env.FAKE_DOCKER_LOG = dockerLog;
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.RUNNER_TEMP = root;
  try {
    const serviceRun = runSelectedService({
      service: "chrome",
      sessionAddress: "http://127.0.0.1:58080",
      credentialFile: credentialFile,
      cancellation: new AbortController().signal,
    });
    const failure = await serviceRun.ready.catch((error) => error);
    assert.deepEqual(failure, { phase: "startup", summary: "Host free space is below the Session floor." });
    assert.deepEqual(await serviceRun.finished, failure);
    const commands = readFileSync(dockerLog, "utf8");
    assert.doesNotMatch(commands, /"run","--detach"/);
    assert.match(commands, /"volume","rm"/);
  } finally {
    if (previous.dockerLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = previous.dockerLog;
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.runnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous.runnerTemp;
    rmSync(root, { recursive: true });
  }
});

test("CL-01 invalid credential location creates no owned resources", async () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "service-invalid-location-runner-"));
  const outside = mkdtempSync(join(tmpdir(), "service-invalid-location-credential-"));
  const credentialFile = join(outside, "session-credential");
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    const serviceRun = runSelectedService({
      service: "chrome",
      sessionAddress: "http://127.0.0.1:58080",
      credentialFile: credentialFile,
      cancellation: new AbortController().signal,
    });
    const failure = await serviceRun.ready.catch((error) => error);
    assert.deepEqual(failure, {
      phase: "startup",
      summary: "Selected Service credential file is outside runner-temporary storage.",
    });
    assert.deepEqual(await serviceRun.finished, failure);
    assert.deepEqual(readdirSync(runnerTemp), []);
    assert.equal(readFileSync(credentialFile, "utf8"), credential);
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    rmSync(runnerTemp, { recursive: true });
    rmSync(outside, { recursive: true });
  }
});

test("CL-01 empty in-scope credential is removed before finished settles", async () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "service-empty-credential-"));
  const credentialFile = join(runnerTemp, "session-credential");
  writeFileSync(credentialFile, "", { mode: 0o600 });
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    const serviceRun = runSelectedService({
      service: "chrome",
      sessionAddress: "http://127.0.0.1:58080",
      credentialFile: credentialFile,
      cancellation: new AbortController().signal,
    });
    const failure = await serviceRun.ready.catch((error) => error);
    assert.deepEqual(failure, { phase: "startup", summary: "Selected Service credential file is invalid." });
    assert.deepEqual(await serviceRun.finished, failure);
    assert.deepEqual(readdirSync(runnerTemp), []);
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    rmSync(runnerTemp, { recursive: true });
  }
});

test("SC-01 Motrix rejects a credential that is not a valid Operator Token", async () => {
  const runnerTemp = mkdtempSync(join(tmpdir(), "service-invalid-motrix-token-"));
  const credentialFile = join(runnerTemp, "motrix-operator-token");
  const rcloneConfigFile = join(runnerTemp, "rclone.conf");
  const invalidToken = "T".repeat(42);
  writeFileSync(credentialFile, invalidToken, { mode: 0o600 });
  writeFileSync(rcloneConfigFile, rcloneConfig, { mode: 0o600 });
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  try {
    const serviceRun = runSelectedService({
      service: "motrix",
      sessionAddress: "http://127.0.0.1:58081",
      credentialFile,
      cancellation: new AbortController().signal,
      upload: { rcloneConfigFile, destinations },
    });
    const failure = await serviceRun.ready.catch((error) => error);
    assert.deepEqual(failure, { phase: "startup", summary: "Selected Service credential file is invalid." });
    assert.deepEqual(await serviceRun.finished, failure);
    assert.deepEqual(readdirSync(runnerTemp), []);
    assert.doesNotMatch(JSON.stringify(failure), new RegExp(invalidToken));
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    rmSync(runnerTemp, { recursive: true });
  }
});

test("UP-00 rejects an Upload Destination whose remote is absent from rclone.conf", async () => {
  const root = mkdtempSync(join(tmpdir(), "service-rclone-remote-"));
  const bin = join(root, "bin");
  const credentialFile = join(root, "session-credential");
  const rcloneConfigFile = join(root, "rclone.conf");
  const dockerLog = join(root, "docker.log");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(rcloneConfigFile, "[archive]\ntype = memory\n", { mode: 0o600 });
  symlinkSync(new URL("./fixtures/fake-docker", import.meta.url).pathname, join(bin, "docker"));
  const previous = { dockerLog: process.env.FAKE_DOCKER_LOG, path: process.env.PATH, runnerTemp: process.env.RUNNER_TEMP };
  process.env.FAKE_DOCKER_LOG = dockerLog;
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.RUNNER_TEMP = root;
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), 1_000);
  try {
    const serviceRun = runSelectedService({
      service: "motrix",
      sessionAddress: "http://127.0.0.1:58081",
      credentialFile: credentialFile,
      cancellation: cancellation.signal,
      upload: { rcloneConfigFile, destinations },
    });
    const failure = await serviceRun.ready.catch((error) => error);
    assert.deepEqual(failure, { phase: "startup", summary: "Rclone Destination remote is not configured." });
    assert.deepEqual(await serviceRun.finished, failure);
    assert.doesNotMatch(readFileSync(dockerLog, "utf8"), /"run","--detach"/);
  } finally {
    clearTimeout(timer);
    if (previous.dockerLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = previous.dockerLog;
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.runnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous.runnerTemp;
    rmSync(root, { recursive: true });
  }
});

test("AU-02 and IS-01 Motrix reads its operator token from a mounted Secret without metadata disclosure", async () => {
  const { commands, root } = await exerciseAdapter("motrix");
  const run = commands.find((command) => command[0] === "run" && command.includes("--detach"));
  const tokenPreparation = commands.find((command) =>
    command[0] === "run" && command.some((/** @type {string} */ argument) => argument.endsWith("-token-permissions")));
  const rcloneValidation = commands.find((command) => command[0] === "run" && command.includes("listremotes"));
  assert.ok(run);
  assert.ok(tokenPreparation);
  assert.ok(rcloneValidation);
  assert.ok(commands.indexOf(tokenPreparation) < commands.indexOf(run));
  assert.ok(tokenPreparation.includes(motrixImage));
  assert.ok(tokenPreparation.includes("--rm"));
  assert.ok(tokenPreparation.includes("0:0"));
  assert.ok(tokenPreparation.includes("none"));
  assert.ok(tokenPreparation.includes("--read-only"));
  assert.ok(tokenPreparation.includes("ALL"));
  assert.ok(tokenPreparation.includes("CHOWN"));
  assert.ok(tokenPreparation.includes("no-new-privileges"));
  const tokenPreparationMounts = tokenPreparation.filter((/** @type {string} */ argument) => argument.startsWith("type="));
  assert.equal(tokenPreparationMounts.length, 1);
  assert.match(tokenPreparationMounts[0], /type=bind,source=.*target=\/run\/secrets\/motrix-operator-token$/);
  assert.doesNotMatch(tokenPreparationMounts[0], /readonly/);
  assert.ok(tokenPreparation.some((/** @type {string} */ argument) => argument.includes("1000:1000:600")));
  assert.ok(run.includes(motrixImage));
  assert.ok(commands.some((command) => command[0] === "pull" && command.includes(rcloneImage)));
  assert.ok(rcloneValidation.includes(rcloneImage));
  assert.ok(rcloneValidation.includes("--read-only"));
  assert.ok(rcloneValidation.includes("ALL"));
  assert.ok(rcloneValidation.includes("no-new-privileges"));
  const configMount = rcloneValidation.find((/** @type {string} */ argument) => argument.includes("target=/config/rclone"));
  assert.ok(configMount);
  assert.doesNotMatch(configMount, /readonly/);
  assert.ok(run.includes("127.0.0.1:58081:8080"));
  assert.equal(run.filter((/** @type {string} */ argument) => argument === "--publish").length, 1);
  assert.doesNotMatch(JSON.stringify(run), /58080/);
  assert.ok(run.includes("1000:1000"));
  assert.ok(run.includes("ALL"));
  assert.ok(run.includes("no-new-privileges"));
  assert.ok(run.includes("MOTRIX_PUBLIC_URL=http://127.0.0.1:58081"));
  assert.ok(run.includes("MOTRIX_DEFAULT_SAVE_DIR=/downloads/drive"));
  assert.ok(run.includes("MOTRIX_ALLOWED_SAVE_DIRS=/downloads/drive:/downloads/backup"));
  assert.ok(run.includes("--entrypoint"));
  assert.ok(run.includes("/bin/sh"));
  assert.ok(run.some((/** @type {string} */ argument) =>
    argument.includes("target=/run/secrets/motrix-operator-token") && argument.includes("readonly")));
  assert.ok(run.some((/** @type {string} */ argument) => argument.includes("export MOTRIX_OPERATOR_TOKEN")));
  assert.doesNotMatch(JSON.stringify(run), /archive:motrix|backup:copies/);
  assert.ok(run.includes("/tmp:rw,noexec,nosuid,size=64m"));
  assert.ok(run.includes("120"));
  assert.doesNotMatch(JSON.stringify(commands), new RegExp(credential));
  assert.doesNotMatch(JSON.stringify(commands), /rclone_config_secret/);
  assert.doesNotMatch(JSON.stringify(run), /16801|privileged|unconfined|docker\.sock/);
  assert.equal(run.some((/** @type {string} */ argument, /** @type {number} */ index) =>
    argument === "--env" && run[index + 1]?.startsWith("MOTRIX_OPERATOR_TOKEN=")), false);
  rmSync(root, { recursive: true });
});

test("AU-02 fake Docker reproduces Motrix exit 64 until token ownership is prepared", () => {
  const root = mkdtempSync(join(tmpdir(), "service-token-permission-model-"));
  const dockerLog = join(root, "docker.log");
  const tokenFile = join(root, "motrix-operator-token");
  const fixture = new URL("./fixtures/fake-docker", import.meta.url).pathname;
  writeFileSync(tokenFile, credential, { mode: 0o600 });
  chmodSync(fixture, 0o755);
  const env = { ...process.env, FAKE_DOCKER_LOG: dockerLog };
  const mainArgs = ["run", "--detach", "--user", "1000:1000", motrixImage, "node", "dist/server/index.mjs"];
  const before = spawnSync(fixture, mainArgs, { env, encoding: "utf8" });
  assert.equal(before.status, 64);
  assert.match(before.stderr, /could not read the operator token file/);
  const preparation = spawnSync(fixture, [
    "run", "--rm", "--name", "test-token-permissions",
    "--mount", `type=bind,source=${tokenFile},target=/run/secrets/motrix-operator-token`,
    motrixImage,
  ], { env, encoding: "utf8" });
  assert.equal(preparation.status, 0);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(spawnSync(fixture, mainArgs, { env }).status, 0);
  rmSync(root, { recursive: true });
});

/** @param {"failure" | "hang"} fault */
async function exerciseMotrixTokenPreparationFault(fault) {
  const root = mkdtempSync(join(tmpdir(), `service-token-permission-${fault}-`));
  const bin = join(root, "bin");
  const credentialFile = join(root, "motrix-operator-token");
  const rcloneConfigFile = join(root, "rclone.conf");
  const dockerLog = join(root, "docker.log");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  writeFileSync(rcloneConfigFile, rcloneConfig, { mode: 0o600 });
  symlinkSync(new URL("./fixtures/fake-docker", import.meta.url).pathname, join(bin, "docker"));
  writeFileSync(`${dockerLog}.token-permission-${fault}`, "injected");
  const previous = {
    dockerLog: process.env.FAKE_DOCKER_LOG,
    path: process.env.PATH,
    runnerTemp: process.env.RUNNER_TEMP,
  };
  process.env.FAKE_DOCKER_LOG = dockerLog;
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.RUNNER_TEMP = root;
  const cancellation = new AbortController();
  let serviceRun;
  try {
    serviceRun = runSelectedService({
      service: "motrix",
      sessionAddress: "http://127.0.0.1:58081",
      credentialFile,
      cancellation: cancellation.signal,
      upload: { rcloneConfigFile, destinations },
    });
    if (fault === "hang") {
      await waitUntil(() => existsSync(dockerLog) && readFileSync(dockerLog, "utf8").includes("token-permissions"));
      cancellation.abort();
    }
    const failure = await serviceRun.ready.catch((error) => error);
    assert.deepEqual(failure, {
      phase: "startup",
      summary: "Motrix Operator Token permission setup failed.",
    });
    assert.deepEqual(await serviceRun.finished, failure);
    assert.throws(() => statSync(credentialFile), { code: "ENOENT" });
    assert.throws(() => statSync(rcloneConfigFile), { code: "ENOENT" });
    const commands = readFileSync(dockerLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const preparation = commands.find((command) => command[0] === "run" && command.some((/** @type {string} */ argument) => argument.endsWith("-token-permissions")));
    assert.ok(preparation);
    assert.equal(commands.some((command) => command[0] === "run" && command.includes("--detach")), false);
    const preparationName = preparation[preparation.indexOf("--name") + 1];
    assert.ok(commands.some((command) => command[0] === "rm" && command.includes(preparationName)));
    assert.equal(commands.filter((command) => command[0] === "volume" && command[1] === "rm").length, 2);
    assert.doesNotMatch(JSON.stringify(commands), new RegExp(credential));
  } finally {
    cancellation.abort();
    if (serviceRun) await serviceRun.finished;
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.runnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous.runnerTemp;
    if (previous.dockerLog === undefined) delete process.env.FAKE_DOCKER_LOG;
    else process.env.FAKE_DOCKER_LOG = previous.dockerLog;
    rmSync(root, { recursive: true });
  }
}

test("CL-01 Motrix token permission setup failure is fixed and fully cleaned up", async () => {
  await exerciseMotrixTokenPreparationFault("failure");
});

test("CL-01 cancellation during Motrix token permission setup cleans residual resources", async () => {
  await exerciseMotrixTokenPreparationFault("hang");
});

test("UP-01 Motrix routes target roots without uploading the internal routing prefix", async () => {
  const { commands, motrixCommands, result, root } = await exerciseAdapter("motrix", "cancel", async ({ health }) => {
    health.tasks = [{
      id: "task-1",
      status: "completed",
      transitionPhase: "idle",
      finalPath: "/downloads/backup/category/file.bin",
    }];
    await waitUntil(() => health.commands.some(({ channel }) => channel === "command:removeTask"));
  });
  const uploads = commands.filter((command) => command[0] === "run" && command.includes("copyto"));
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].includes(rcloneImage));
  assert.ok(uploads[0].includes("/downloads/backup/category/file.bin"));
  assert.ok(uploads[0].includes("backup:copies/category/file.bin"));
  assert.doesNotMatch(JSON.stringify(uploads[0]), /backup:copies\/backup/);
  assert.ok(uploads[0].some((/** @type {string} */ argument) => argument.includes("target=/downloads") && argument.includes("readonly")));
  assert.ok(uploads[0].includes("--read-only"));
  assert.ok(uploads[0].includes("ALL"));
  assert.ok(uploads[0].includes("no-new-privileges"));
  assert.doesNotMatch(JSON.stringify(uploads), /rclone_config_secret/);
  assert.deepEqual(motrixCommands, [{
    channel: "command:removeTask",
    args: [{ taskId: "task-1", deleteWithFiles: true }],
  }]);
  assert.deepEqual(result, { status: "success" });
  rmSync(root, { recursive: true });
});

test("UP-01 waits for finalization and cleans up BT in upload-stop-remove order", async () => {
  const { commands, motrixCommands, root } = await exerciseAdapter("motrix", "cancel", async ({ health, dockerLog }) => {
    health.tasks = [{
      id: "task-2",
      status: "completed",
      transitionPhase: "renaming",
      finalPath: "/downloads/drive/movie",
    }];
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.doesNotMatch(readFileSync(dockerLog, "utf8"), /copyto/);
    health.tasks = [{
      id: "task-2",
      type: "bt",
      status: "seeding",
      transitionPhase: "idle",
      finalPath: "/downloads/drive/movie",
    }];
    await waitUntil(() => health.commands.some(({ channel }) => channel === "command:removeTask"));
  });
  assert.equal(commands.filter((command) => command[0] === "run" && command.includes("copyto")).length, 1);
  assert.deepEqual(motrixCommands.map(({ channel }) => channel), [
    "command:stopSeedingTask",
    "command:removeTask",
  ]);
  rmSync(root, { recursive: true });
});

test("UP-02 a failed upload is deferred so the next completed task can upload", async () => {
  const sensitiveError = JSON.stringify({
    level: "error",
    msg: "429 Too Many Requests while copying archive:motrix/private-a.bin token=rclone_config_secret",
    object: "/downloads/drive/a.bin",
  });
  const { commands, output, result, root } = await exerciseAdapter("motrix", "cancel", async ({ health, dockerLog }) => {
    writeFileSync(`${dockerLog}.rclone-failures`, "1");
    writeFileSync(`${dockerLog}.rclone-exit-code`, "5");
    writeFileSync(`${dockerLog}.rclone-error`, sensitiveError);
    health.tasks = [
      { id: "task-a", status: "completed", transitionPhase: "idle", finalPath: "/downloads/drive/a.bin" },
      { id: "task-b", status: "completed", transitionPhase: "idle", finalPath: "/downloads/backup/b.bin" },
    ];
    await waitUntil(() => {
      const log = readFileSync(dockerLog, "utf8");
      return (log.match(/copyto/g) ?? []).length >= 3 && health.commands.length >= 2;
    });
    assert.equal(readFileSync(`${dockerLog}.rclone-failures`, "utf8"), "0");
  });
  const uploads = commands.filter((command) => command[0] === "run" && command.includes("copyto"));
  assert.equal(uploads.length, 3);
  assert.ok(uploads[0].includes("/downloads/drive/a.bin"));
  assert.ok(uploads[1].includes("/downloads/backup/b.bin"));
  assert.ok(uploads[2].includes("/downloads/drive/a.bin"));
  assert.match(output.join("\n"), /Rclone upload failed \(item 1, destination drive, attempt 1, category temporary, exit 5\); retry scheduled/);
  assert.match(output.join("\n"), /Rclone upload completed \(item 2, destination backup\)/);
  assert.match(output.join("\n"), /Rclone upload completed \(item 1, destination drive\)/);
  assert.doesNotMatch(output.join("\n"), /private-a\.bin|archive:motrix|rclone_config_secret|\/downloads/);
  assert.deepEqual(result, { status: "success" });
  rmSync(root, { recursive: true });
});

test("UP-02 a permanent rclone failure is parked without exposing diagnostics", async () => {
  const sensitiveError = JSON.stringify({
    level: "error",
    msg: "fatal error for backup:copies/private.bin token=rclone_config_secret",
    object: "/downloads/backup/private.bin",
  });
  const { commands, output, result, root } = await exerciseAdapter("motrix", "cancel", async ({ health, dockerLog }) => {
    writeFileSync(`${dockerLog}.rclone-failures`, "1");
    writeFileSync(`${dockerLog}.rclone-exit-code`, "7");
    writeFileSync(`${dockerLog}.rclone-error`, sensitiveError);
    health.tasks = [
      {
        id: "task-permanent",
        status: "completed",
        transitionPhase: "idle",
        finalPath: "/downloads/backup/private.bin",
      },
      {
        id: "task-after-permanent",
        status: "completed",
        transitionPhase: "idle",
        finalPath: "/downloads/drive/after.bin",
      },
    ];
    await waitUntil(() => health.commands.some(({ channel }) => channel === "command:removeTask"));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });
  const uploads = commands.filter((command) => command[0] === "run" && command.includes("copyto"));
  assert.equal(uploads.length, 2);
  assert.ok(uploads[1].includes("/downloads/drive/after.bin"));
  assert.match(output.join("\n"), /Rclone upload queued \(item 1, destination backup\)/);
  assert.match(output.join("\n"), /Rclone upload failed \(item 1, destination backup, attempt 1, category fatal, exit 7\); no retry scheduled\./);
  assert.match(output.join("\n"), /Rclone upload completed \(item 2, destination drive\)/);
  assert.doesNotMatch(output.join("\n"), /private\.bin|backup:copies|rclone_config_secret|\/downloads/);
  assert.deepEqual(result, {
    phase: "runtime",
    summary: "Motrix upload or task cleanup remained incomplete.",
  });
  rmSync(root, { recursive: true });
});

test("UP-03 cleanup failures retry native cleanup without uploading again", async () => {
  const { commands, motrixCommands, result, root } = await exerciseAdapter(
    "motrix",
    "cancel",
    async ({ health }) => {
      health.cleanupFailures = 1;
      health.tasks = [{
        id: "task-cleanup-retry",
        status: "completed",
        transitionPhase: "idle",
        finalPath: "/downloads/drive/retry.bin",
      }];
      await waitUntil(() => health.commands.length >= 2);
    },
  );
  assert.equal(commands.filter((command) => command[0] === "run" && command.includes("copyto")).length, 1);
  assert.deepEqual(motrixCommands.map(({ channel }) => channel), [
    "command:removeTask",
    "command:removeTask",
  ]);
  assert.deepEqual(result, { status: "success" });
  rmSync(root, { recursive: true });
});

test("UP-01 rejects completed task paths outside the downloads root", async () => {
  const { commands, root } = await exerciseAdapter("motrix", "cancel", async ({ health }) => {
    health.tasks = [
      { id: "task-root", status: "completed", transitionPhase: "idle", finalPath: "/downloads" },
      { id: "task-target-root", status: "completed", transitionPhase: "idle", finalPath: "/downloads/drive" },
      { id: "task-unknown", status: "completed", transitionPhase: "idle", finalPath: "/downloads/unknown/file" },
      { id: "task-escape", status: "completed", transitionPhase: "idle", finalPath: "/downloads/drive/../../etc/passwd" },
    ];
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });
  assert.equal(commands.filter((command) => command[0] === "run" && command.includes("copyto")).length, 0);
  rmSync(root, { recursive: true });
});
