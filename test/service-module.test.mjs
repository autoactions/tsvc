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
const openlistImage = "openlistteam/openlist@sha256:b4de1e8e07de352a57e8f9eefbe5525c4a6eeef0ae4c74c2a1e68cb71d185fdb";
const codeServerImage = "lscr.io/linuxserver/code-server@sha256:212d588e21815316d6525abe8d14bb0114fc2cf0499f08e9e34a1b514b1055b9";

/** @typedef {"chrome" | "openlist" | "code-server"} Service */

/** @param {Service} service */
function serviceOrigin(service) {
  if (service === "chrome") return "http://127.0.0.1:58080";
  if (service === "code-server") return "http://127.0.0.1:58084";
  return "http://127.0.0.1:58082";
}

/** @param {Service} service @param {{ healthy: boolean, localLoginHealthy: boolean, publicHealthy: boolean, offlineTools: string[], offlineToolsRequests: number, openlistAdminState: string, tasks: unknown[], commands: { channel: string, args: unknown[] }[], cleanupFailures: number }} health */
function startServiceServer(service, health) {
  const basic = `Basic ${Buffer.from(`admin:${credential}`).toString("base64")}`;
  const server = createServer((request, response) => {
    if (!health.healthy) {
      response.writeHead(503).end();
      return;
    }
    if (request.url === "/healthz") {
      response.writeHead(200).end('{"ok":true}');
      return;
    }
    if (service === "code-server" && request.url === "/") {
      response.writeHead(200).end("code-server");
      return;
    }
    if (service === "openlist" && request.url === "/") {
      response.writeHead(health.publicHealthy ? 200 : 503).end("openlist");
      return;
    }
    if (service === "openlist" && request.method === "POST" && request.url === "/api/auth/login") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const payload = JSON.parse(body);
        if (
          health.localLoginHealthy && payload.username === "admin" &&
          payload.password === readFileSync(health.openlistAdminState, "utf8")
        ) {
          response.writeHead(200, { "content-type": "application/json" })
            .end('{"code":200,"data":{"token":"test-token"}}');
        } else response.writeHead(401).end('{"code":401}');
      });
      return;
    }
    if (service === "openlist" && request.method === "GET" && request.url === "/api/public/offline_download_tools") {
      health.offlineToolsRequests += 1;
      response.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ code: 200, message: "success", data: health.offlineTools }));
      return;
    }
    if (service === "chrome" && request.url === "/" && request.headers.authorization === basic) {
      response.writeHead(200).end("chrome");
      return;
    }
    response.writeHead(401).end();
  });
  server.on("upgrade", (request, socket) => {
    if (!health.healthy) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    const expectedPath = "/websocket";
    const expectedAuth = basic;
    if (request.url === expectedPath && request.headers.authorization === expectedAuth) {
      socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    } else {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    }
  });
  const port = service === "chrome" ? 58080 : service === "code-server" ? 58084 : 58082;
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/**
 * @param {Service} service
 * @param {"cancel" | "exit" | "unhealthy" | "rclone-exit"} [termination]
 * @param {(context: { health: { healthy: boolean, localLoginHealthy: boolean, publicHealthy: boolean, offlineTools: string[], offlineToolsRequests: number, openlistAdminState: string, tasks: unknown[], commands: { channel: string, args: unknown[] }[], cleanupFailures: number }, dockerLog: string, output: string[] }) => Promise<void>} [onReady]
 * @param {{ initialOpenListPassword?: string, startupFailure?: "bootstrap" | "local-login" | "offline-tools" | "public" | "rclone", rclone?: boolean }} [scenario]
 */
async function exerciseAdapter(service, termination = "cancel", onReady, scenario = {}) {
  const root = mkdtempSync(join(tmpdir(), `service-module-${service}-`));
  const bin = join(root, "bin");
  const credentialFile = join(root, "session-credential");
  const rcloneConfigFile = join(root, "rclone.conf");
  const databaseFile = join(root, "database.json");
  const databaseCaFile = join(root, "database-ca.pem");
  const dockerLog = join(root, "docker.log");
  const openlistAdminState = `${dockerLog}.openlist-admin`;
  const fixture = new URL("./fixtures/fake-docker", import.meta.url).pathname;
  const rcloneFixture = new URL("./fixtures/fake-rclone", import.meta.url).pathname;
  const mountToolFixture = new URL("./fixtures/fake-mount-tool", import.meta.url).pathname;
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  if (scenario.rclone) writeFileSync(rcloneConfigFile, "[archive]\ntype = memory\n", { mode: 0o600 });
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
    if (scenario.initialOpenListPassword !== undefined) {
      writeFileSync(openlistAdminState, scenario.initialOpenListPassword, { mode: 0o600 });
    }
    if (scenario.startupFailure === "bootstrap") {
      writeFileSync(`${dockerLog}.openlist-bootstrap-failure`, "injected");
    }
  }
  await import("node:fs/promises").then(({ mkdir }) => mkdir(bin));
  chmodSync(fixture, 0o755);
  chmodSync(rcloneFixture, 0o755);
  chmodSync(mountToolFixture, 0o755);
  symlinkSync(fixture, join(bin, "docker"));
  symlinkSync(mountToolFixture, join(bin, "mountpoint"));
  symlinkSync(mountToolFixture, join(bin, "fusermount3"));

  const previous = {
    dockerLog: process.env.FAKE_DOCKER_LOG,
    rcloneFixture: process.env.FAKE_RCLONE_FIXTURE,
    path: process.env.PATH,
    runnerTemp: process.env.RUNNER_TEMP,
  };
  process.env.FAKE_DOCKER_LOG = dockerLog;
  process.env.FAKE_RCLONE_FIXTURE = rcloneFixture;
  process.env.PATH = `${bin}:${previous.path}`;
  process.env.RUNNER_TEMP = root;
  const health = {
    healthy: true,
    localLoginHealthy: scenario.startupFailure !== "local-login",
    publicHealthy: scenario.startupFailure !== "public",
    offlineTools: scenario.startupFailure === "offline-tools" ? ["SimpleHttp"] : ["aria2", "SimpleHttp"],
    offlineToolsRequests: 0,
    openlistAdminState,
    tasks: [],
    commands: [],
    cleanupFailures: 0,
  };
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
      ...(scenario.rclone ? {
        rclone: {
          configFile: rcloneConfigFile,
          mounts: [scenario.startupFailure === "rclone"
            ? { id: "missing", source: "missing:folder", remote: "missing" }
            : { id: "archive", source: "archive:folder", remote: "archive" }],
        },
      } : {}),
      ...(service === "openlist"
        ? { database: { file: databaseFile, caFile: databaseCaFile } }
        : {}),
    });
    if (scenario.startupFailure) {
      if (scenario.startupFailure === "bootstrap" || scenario.startupFailure === "rclone") {
        // The injected bootstrap command settles on its own.
      } else if (scenario.startupFailure === "offline-tools") {
        await waitUntil(() => health.offlineToolsRequests > 0);
      } else if (scenario.startupFailure === "public") {
        await waitUntil(() => output.includes("Startup stage complete: Local OpenList admin login."));
      } else {
        await waitUntil(() => output.includes("Startup stage complete: Service container."));
      }
      if (scenario.startupFailure !== "bootstrap" && scenario.startupFailure !== "rclone") cancellation.abort();
      const failure = await serviceRun.ready.catch((error) => error);
      const result = await serviceRun.finished;
      const commands = readFileSync(dockerLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      return { commands, output, result, root, startupFailure: failure };
    }
    const ready = await serviceRun.ready;
    if (service === "code-server") {
      assert.equal(ready.username, undefined);
      assert.match(ready.accessGuidance, /code-server.*Session Credential/);
    } else {
      assert.equal(ready.username, "admin");
      assert.match(
        ready.accessGuidance,
        service === "chrome" ? /Session Credential/ : /OpenList.*admin.*Session Credential/,
      );
    }
    if (onReady) await onReady({ health, dockerLog, output });
    if (termination === "cancel") cancellation.abort();
    else if (termination === "exit") writeFileSync(`${dockerLog}.stopped`, "stopped");
    else if (termination === "rclone-exit") writeFileSync(`${dockerLog}.rclone-stop`, "stopped");
    else health.healthy = false;
    const result = await serviceRun.finished;
    assert.throws(() => statSync(credentialFile), { code: "ENOENT" });
    if (scenario.rclone) assert.throws(() => statSync(rcloneConfigFile), { code: "ENOENT" });
    if (service === "openlist") {
      assert.throws(() => statSync(databaseFile), { code: "ENOENT" });
      assert.throws(() => statSync(databaseCaFile), { code: "ENOENT" });
    }

    const commands = readFileSync(dockerLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    return { commands, output, result, root };
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
    if (previous.rcloneFixture === undefined) delete process.env.FAKE_RCLONE_FIXTURE;
    else process.env.FAKE_RCLONE_FIXTURE = previous.rcloneFixture;
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
  assert.ok(run.includes("CUSTOM_USER=admin"));
  assert.ok(run.includes("FILE__PASSWORD=/run/secrets/session-credential"));
  assert.doesNotMatch(JSON.stringify(commands), new RegExp(credential));
  assert.doesNotMatch(JSON.stringify(run), /3001|8082|privileged|unconfined|docker\.sock/);
  rmSync(root, { recursive: true });
});

test("AU-04 and IS-01 Code Server uses native file-backed authentication and one confined Origin", async () => {
  const { commands, root } = await exerciseAdapter("code-server");
  const run = commands.find((command) => command[0] === "run" && command.includes("--detach"));
  assert.ok(run);
  assert.ok(run.includes(codeServerImage));
  assert.ok(run.includes("127.0.0.1:58084:8443"));
  assert.equal(run.filter((/** @type {string} */ argument) => argument === "--publish").length, 1);
  assert.ok(run.includes("FILE__PASSWORD=/run/secrets/session-credential"));
  assert.doesNotMatch(JSON.stringify(commands), new RegExp(credential));
  assert.doesNotMatch(JSON.stringify(run), /privileged|unconfined|docker\.sock/);
  rmSync(root, { recursive: true });
});

test("SC-03 mounts configured Rclone paths into any selected Service", async () => {
  for (const service of [/** @type {const} */ ("chrome"), /** @type {const} */ ("openlist"), /** @type {const} */ ("code-server")]) {
    const { commands, result, root } = await exerciseAdapter(service, "cancel", undefined, { rclone: true });
    assert.deepEqual(result, { status: "success" });
    assert.ok(commands.some((command) => command[0] === "pull" && command.includes("rclone/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548")));
    assert.ok(commands.some((command) => command[0] === "create" && command.includes("/bin/true")));
    const run = commands.find((command) => command[0] === "run" && command.includes("--detach"));
    assert.ok(run?.some((/** @type {string} */ argument) => /target=\/mnt\/rclone\/archive$/.test(argument)));
    assert.doesNotMatch(JSON.stringify(commands), /rclone_config_secret/);
    rmSync(root, { recursive: true });
  }
});

test("SC-03 rejects a mount whose remote is absent from rclone.conf", async () => {
  const { result, root, startupFailure } = await exerciseAdapter(
    "chrome", "cancel", undefined, { rclone: true, startupFailure: "rclone" },
  );
  assert.deepEqual(startupFailure, { phase: "startup", summary: "Rclone mount remote is not configured." });
  assert.deepEqual(result, startupFailure);
  rmSync(root, { recursive: true });
});

test("FL-01 fails a Ready Session when a Rclone mount exits", async () => {
  const { result, root } = await exerciseAdapter("chrome", "rclone-exit", undefined, { rclone: true });
  assert.deepEqual(result, { phase: "runtime", summary: "Rclone mount exited." });
  rmSync(root, { recursive: true });
});

test("AU-03, IS-01, and PS-01 OpenList bootstraps a persistent database behind one confined Origin", async () => {
  const { commands, output, result, root } = await exerciseAdapter("openlist", "cancel", async ({ dockerLog, health }) => {
    assert.ok(health.offlineToolsRequests > 0);
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
    assert.equal(config.temp_dir, "/opt/openlist/data/temp");
    assert.equal(config.bleve_dir, "/tmp/openlist-bleve");
  });
  const permission = commands.find((command) => command.some((/** @type {string} */ argument) => argument.endsWith("-openlist-permissions")));
  const configuration = commands.find((command) => command.some((/** @type {string} */ argument) => argument.endsWith("-openlist-configuration")));
  const bootstrap = commands.find((command) => command.some((/** @type {string} */ argument) => argument.endsWith("-openlist-bootstrap")));
  const run = commands.find((command) => command[0] === "run" && command.includes("--detach"));
  assert.ok(permission && configuration && bootstrap && run);
  assert.ok(permission.includes("--read-only"));
  assert.ok(configuration.includes("--read-only"));
  assert.ok(bootstrap.includes("--read-only"));
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
  const bootstrapScript = bootstrap[bootstrap.indexOf("-c") + 1];
  assert.match(bootstrapScript, /\.\/openlist admin set/);
  assert.match(bootstrapScript, />\/dev\/null 2>&1/);
  assert.ok(run.includes(openlistImage));
  assert.ok(run.includes("127.0.0.1:58082:5244"));
  assert.ok(run.includes("1001:1001"));
  assert.ok(!run.includes("--read-only"));
  assert.ok(run.includes("--init"));
  assert.ok(run.includes("ALL"));
  assert.ok(run.includes("no-new-privileges"));
  assert.ok(run.includes("RUN_ARIA2=true"));
  assert.ok(run.includes("SSL_CERT_FILE=/opt/openlist/data/database-ca.pem"));
  assert.equal(run.filter((/** @type {string} */ argument) => argument === "--publish").length, 1);
  assert.doesNotMatch(JSON.stringify(run), /5245|6800|6881|session-credential|OPENLIST_ADMIN_PASSWORD/);
  assert.doesNotMatch(JSON.stringify(commands), new RegExp(`${credential}|database_secret_value`));
  assert.deepEqual(result, { status: "success" });
  assert.ok(commands.some((command) => command[0] === "volume" && command[1] === "rm"));
  assert.equal(readFileSync(join(root, "docker.log.openlist-admin"), "utf8"), credential);
  assert.doesNotMatch(output.join("\n"), new RegExp(credential));
  assert.deepEqual(output.filter((line) => line.startsWith("Startup stage complete:")), [
    "Startup stage complete: Service image.",
    "Startup stage complete: OpenList database bootstrap.",
    "Startup stage complete: Service container.",
    "Startup stage complete: Local OpenList admin login.",
    "Startup stage complete: Public access.",
  ]);
  assert.doesNotMatch(output.filter((line) => line.startsWith("Startup stage complete:")).join("\n"), /https?:|127\.0\.0\.1|mysql|password|secret/i);
  rmSync(root, { recursive: true });
});

test("AU-03 OpenList reapplies the Session Credential to an existing admin", async () => {
  const oldCredential = "old-persisted-admin-password";
  const { commands, output, result, root } = await exerciseAdapter(
    "openlist",
    "cancel",
    undefined,
    { initialOpenListPassword: oldCredential },
  );
  assert.equal(readFileSync(join(root, "docker.log.openlist-admin"), "utf8"), credential);
  assert.deepEqual(result, { status: "success" });
  const observable = `${JSON.stringify(commands)}${output.join("\n")}`;
  assert.doesNotMatch(observable, new RegExp(credential));
  assert.doesNotMatch(observable, new RegExp(oldCredential));
  rmSync(root, { recursive: true });
});

test("FL-01 OpenList reports a local admin login that never becomes ready", async () => {
  const { commands, output, result, root, startupFailure } = await exerciseAdapter(
    "openlist", "cancel", undefined, { startupFailure: "local-login" },
  );
  assert.deepEqual(startupFailure, { phase: "startup", summary: "Local OpenList login was not ready." });
  assert.deepEqual(result, startupFailure);
  assert.doesNotMatch(`${JSON.stringify(commands)}${output.join("\n")}`, new RegExp(credential));
  rmSync(root, { recursive: true });
});

test("FL-01 OpenList reports offline download tools without aria2 as not ready", async () => {
  const { commands, output, result, root, startupFailure } = await exerciseAdapter(
    "openlist", "cancel", undefined, { startupFailure: "offline-tools" },
  );
  assert.deepEqual(startupFailure, {
    phase: "startup",
    summary: "OpenList offline download tools were not ready.",
  });
  assert.deepEqual(result, startupFailure);
  assert.ok(commands.some((command) => command[0] === "volume" && command[1] === "rm"));
  assert.doesNotMatch(
    `${JSON.stringify(commands)}${output.join("\n")}${JSON.stringify(result)}`,
    new RegExp(`${credential}|database_secret_value`),
  );
  rmSync(root, { recursive: true });
});

test("FL-01 OpenList reports a database bootstrap failure without sensitive output", async () => {
  const { commands, output, result, root, startupFailure } = await exerciseAdapter(
    "openlist", "cancel", undefined, { startupFailure: "bootstrap" },
  );
  assert.deepEqual(startupFailure, { phase: "startup", summary: "OpenList database bootstrap failed." });
  assert.deepEqual(result, startupFailure);
  assert.doesNotMatch(`${JSON.stringify(commands)}${output.join("\n")}${JSON.stringify(result)}`, new RegExp(credential));
  assert.doesNotMatch(`${JSON.stringify(commands)}${output.join("\n")}${JSON.stringify(result)}`, /database_secret_value/);
  rmSync(root, { recursive: true });
});

test("FL-01 OpenList reports public access that never becomes ready", async () => {
  const { commands, output, result, root, startupFailure } = await exerciseAdapter(
    "openlist", "cancel", undefined, { startupFailure: "public" },
  );
  assert.deepEqual(startupFailure, { phase: "startup", summary: "Public access was not ready." });
  assert.deepEqual(result, startupFailure);
  assert.doesNotMatch(`${JSON.stringify(commands)}${output.join("\n")}`, new RegExp(credential));
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
