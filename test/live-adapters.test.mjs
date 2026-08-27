import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSelectedService } from "../src/service-module.mjs";

const enabled = process.env.RUN_LIVE_ADAPTER_TESTS === "1";
const openlistEnabled = enabled && Boolean(process.env.DATABASE && process.env.DATABASE_CA);
const sessionCredential = "123456";

/** @param {"chrome" | "openlist" | "code-server"} service */
function servicePort(service) {
  if (service === "chrome") return 58080;
  if (service === "code-server") return 58084;
  return 58082;
}

/** @param {"chrome"} service @param {string} path @param {Record<string, string>} headers */
function websocketStatus(service, path, headers) {
  return new Promise((resolve, reject) => {
    const request = http.request(`http://127.0.0.1:${servicePort(service)}${path}`, {
      headers: {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": Buffer.alloc(16, 1).toString("base64"),
        "sec-websocket-version": "13",
      },
    });
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("error", reject);
    request.end();
  });
}

/** @param {"chrome" | "openlist" | "code-server"} service @param {string} credential @param {string[]} [additionalSensitiveValues] */
function assertLiveIsolation(service, credential, additionalSensitiveValues = []) {
  const ids = execFileSync("docker", ["ps", "--quiet", "--filter", `publish=${servicePort(service)}`], { encoding: "utf8" })
    .trim().split("\n").filter(Boolean);
  assert.equal(ids.length, 1);
  const id = ids[0];
  assert.ok(id);
  const metadataText = execFileSync("docker", ["inspect", id], { encoding: "utf8" });
  const [metadata] = JSON.parse(metadataText);
  assert.equal(metadata.HostConfig.Privileged, false);
  assert.equal(metadata.HostConfig.NetworkMode, "bridge");
  assert.deepEqual(metadata.HostConfig.CapAdd, null);
  assert.deepEqual(metadata.HostConfig.Devices, []);
  assert.equal(Object.keys(metadata.HostConfig.PortBindings).length, 1);
  assert.deepEqual(
    Object.keys(metadata.HostConfig.PortBindings),
    [service === "chrome" ? "3000/tcp" : service === "code-server" ? "8443/tcp" : "5244/tcp"],
  );
  const logs = execFileSync("docker", ["logs", "--tail", "200", id], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  const processes = execFileSync("docker", ["top", id, "-eo", "pid,args"], { encoding: "utf8" });
  const observableState = `${metadataText}${logs}${processes}`;
  for (const value of [credential, ...additionalSensitiveValues]) {
    assert.doesNotMatch(observableState, new RegExp(value));
  }
}

/** @param {"chrome" | "openlist" | "code-server"} service */
async function withLiveService(service) {
  const root = mkdtempSync(join(tmpdir(), `live-${service}-`));
  const credentialFile = join(root, "session-credential");
  const databaseFile = join(root, "database.json");
  const databaseCaFile = join(root, "database-ca.pem");
  const credential = sessionCredential;
  writeFileSync(credentialFile, credential, { mode: 0o600 });
  if (service === "openlist") {
    writeFileSync(databaseFile, process.env.DATABASE ?? "", { mode: 0o600 });
    writeFileSync(databaseCaFile, process.env.DATABASE_CA ?? "", { mode: 0o600 });
  }
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = root;
  const cancellation = new AbortController();
  const serviceRun = runSelectedService({
    service,
    sessionAddress: `http://127.0.0.1:${servicePort(service)}`,
    credentialFile: credentialFile,
    cancellation: cancellation.signal,
    ...(service === "openlist" ? { database: { file: databaseFile, caFile: databaseCaFile } } : {}),
  });
  try {
    await serviceRun.ready;
    return { cancellation, previousRunnerTemp, root, serviceRun };
  } catch (error) {
    cancellation.abort();
    await serviceRun.finished;
    rmSync(root, { recursive: true });
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    throw error;
  }
}

test("AU-01 pinned Chrome enforces native HTTP and GUI WebSocket authentication", { skip: !enabled, timeout: 300_000 }, async () => {
  const live = await withLiveService("chrome");
  try {
    const wrong = `Basic ${Buffer.from("session:wrong").toString("base64")}`;
    const correct = `Basic ${Buffer.from(`session:${sessionCredential}`).toString("base64")}`;
    assertLiveIsolation("chrome", sessionCredential);
    assert.equal((await fetch("http://127.0.0.1:58080/", { headers: { authorization: wrong } })).status, 401);
    assert.equal((await fetch("http://127.0.0.1:58080/", { headers: { authorization: correct } })).status, 200);
    assert.equal(await websocketStatus("chrome", "/websocket", { authorization: wrong }), 401);
    assert.equal(await websocketStatus("chrome", "/websocket", { authorization: correct }), 101);
  } finally {
    live.cancellation.abort();
    assert.deepEqual(await live.serviceRun.finished, { status: "success" });
    rmSync(live.root, { recursive: true });
    if (live.previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = live.previousRunnerTemp;
  }
});

test("AU-03 pinned OpenList authenticates with the current Session Credential", { skip: !openlistEnabled, timeout: 300_000 }, async () => {
  const live = await withLiveService("openlist");
  try {
    assertLiveIsolation("openlist", sessionCredential);
    /** @param {string} password */
    const login = (password) => fetch("http://127.0.0.1:58082/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password }),
    });
    const rejected = await login("wrong-password");
    assert.notEqual((await rejected.json()).code, 200);
    const response = await login(sessionCredential);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.code, 200);
    assert.equal(typeof payload.data?.token, "string");
    const toolsResponse = await fetch("http://127.0.0.1:58082/api/public/offline_download_tools");
    assert.equal(toolsResponse.status, 200);
    const toolsPayload = await toolsResponse.json();
    assert.equal(toolsPayload.code, 200);
    assert.ok(Array.isArray(toolsPayload.data));
    assert.ok(toolsPayload.data.includes("aria2"));
    assert.ok(toolsPayload.data.includes("SimpleHttp"));
  } finally {
    live.cancellation.abort();
    assert.deepEqual(await live.serviceRun.finished, { status: "success" });
    rmSync(live.root, { recursive: true });
    if (live.previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = live.previousRunnerTemp;
  }
});

test("AU-04 pinned Code Server authenticates with the current Session Credential", { skip: !enabled, timeout: 300_000 }, async () => {
  const live = await withLiveService("code-server");
  try {
    assertLiveIsolation("code-server", sessionCredential);
    const response = await fetch("http://127.0.0.1:58084/");
    assert.equal(response.status, 200);
  } finally {
    live.cancellation.abort();
    assert.deepEqual(await live.serviceRun.finished, { status: "success" });
    rmSync(live.root, { recursive: true });
    if (live.previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = live.previousRunnerTemp;
  }
});
