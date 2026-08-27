#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { isAbsolute, resolve, sep } from "node:path";

import { writeLocatorArtifact } from "./locator-artifact.mjs";
import { runSelectedService } from "./service-module.mjs";
import { parseRcloneMounts } from "./rclone-mounts.mjs";

const SERVICE_ORIGINS = {
  chrome: "http://127.0.0.1:58080",
  openlist: "http://127.0.0.1:58082",
};
const METRICS_ORIGIN = "http://127.0.0.1:49312";
const STARTUP_TIMEOUT_MS = process.env.NODE_TEST_CONTEXT && process.env.TSVC_TEST_STARTUP_TIMEOUT_MS
  ? Number(process.env.TSVC_TEST_STARTUP_TIMEOUT_MS)
  : 5 * 60_000;
const LOG_SIZE = 10 * 1024 * 1024;
const LOG_FILES = 3;
const ARGUMENT_NAMES = new Set([
  "service",
  "credential-file",
  "cloudflared",
  "started-epoch-file",
  "rclone-config-file",
  "rclone-mounts-file",
  "database-file",
  "database-ca-file",
  "sensitive-facts-file",
]);

/** @typedef {"chrome" | "openlist"} Service */
/**
 * @typedef {{
 *   service: Service,
 *   credentialFile: string,
 *   cloudflared: string,
 *   startedEpochFile: string,
 *   rclone?: { configFile: string, mountsFile: string },
 *   database?: { file: string, caFile: string },
 *   sensitiveFactsFile?: string,
 * }} SessionOptions
 */

class FixedSessionError extends Error {
  /** @param {"startup" | "runtime" | "cleanup"} phase @param {string} summary */
  constructor(phase, summary) {
    super(summary);
    this.phase = phase;
    this.summary = summary;
  }
}

class BoundedLog {
  /** @param {string} path */
  constructor(path) {
    this.path = path;
  }

  /** @param {Buffer} chunk */
  append(chunk) {
    const bounded = chunk.subarray(-LOG_SIZE);
    const currentSize = existsSync(this.path) ? statSync(this.path).size : 0;
    if (currentSize + bounded.length > LOG_SIZE) this.rotate();
    appendFileSync(this.path, bounded, { mode: 0o600 });
  }

  rotate() {
    for (let index = LOG_FILES - 1; index >= 1; index -= 1) {
      const source = index === 1 ? this.path : `${this.path}.${index - 1}`;
      const destination = `${this.path}.${index}`;
      if (existsSync(source)) renameSync(source, destination);
    }
  }
}

/** @param {string[]} argv @returns {SessionOptions} */
function parseArguments(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new FixedSessionError("startup", "Session arguments are invalid.");
    }
    const name = key.slice(2);
    if (!ARGUMENT_NAMES.has(name) || Object.hasOwn(values, name)) {
      throw new FixedSessionError("startup", "Session arguments are invalid.");
    }
    values[name] = value;
  }
  const service = values.service;
  const credentialFile = values["credential-file"];
  const cloudflared = values.cloudflared;
  const startedEpochFile = values["started-epoch-file"];
  const rcloneConfigFile = values["rclone-config-file"];
  const rcloneMountsFile = values["rclone-mounts-file"];
  const databaseFile = values["database-file"];
  const databaseCaFile = values["database-ca-file"];
  const sensitiveFactsFile = values["sensitive-facts-file"];
  if (
    (service !== "chrome" && service !== "openlist") ||
    !credentialFile || !cloudflared || !startedEpochFile ||
    ![credentialFile, cloudflared, startedEpochFile].every(isAbsolute)
  ) {
    throw new FixedSessionError("startup", "Session arguments are invalid.");
  }
  if (sensitiveFactsFile && !isAbsolute(sensitiveFactsFile)) {
    throw new FixedSessionError("startup", "Session arguments are invalid.");
  }
  if (
    Boolean(rcloneConfigFile) !== Boolean(rcloneMountsFile) ||
    (rcloneConfigFile && !isAbsolute(rcloneConfigFile)) ||
    (rcloneMountsFile && !isAbsolute(rcloneMountsFile))
  ) {
    throw new FixedSessionError("startup", "Session arguments are invalid.");
  }
  if (
    (service === "openlist" && (!databaseFile || !databaseCaFile)) ||
    (service !== "openlist" && (databaseFile || databaseCaFile)) ||
    (databaseFile && !isAbsolute(databaseFile)) ||
    (databaseCaFile && !isAbsolute(databaseCaFile))
  ) {
    throw new FixedSessionError("startup", "Session arguments are invalid.");
  }
  const rclone = rcloneConfigFile && rcloneMountsFile
    ? { configFile: rcloneConfigFile, mountsFile: rcloneMountsFile }
    : undefined;
  const database = databaseFile && databaseCaFile
    ? { file: databaseFile, caFile: databaseCaFile }
    : undefined;
  return {
    service, credentialFile, cloudflared, startedEpochFile,
    ...(rclone ? { rclone } : {}),
    ...(database ? { database } : {}),
    ...(sensitiveFactsFile ? { sensitiveFactsFile } : {}),
  };
}

/** @param {SessionOptions} options */
function validateRunnerTemporaryPaths(options) {
  const runnerTemp = resolve(process.env.RUNNER_TEMP ?? "");
  if (!isAbsolute(runnerTemp) || runnerTemp === sep) {
    throw new FixedSessionError("startup", "Runner temporary storage is invalid.");
  }
  const paths = [options.credentialFile, options.cloudflared, options.startedEpochFile];
  if (options.rclone) paths.push(options.rclone.configFile, options.rclone.mountsFile);
  if (options.database) paths.push(options.database.file, options.database.caFile);
  if (options.sensitiveFactsFile) paths.push(options.sensitiveFactsFile);
  for (const path of paths) {
    const resolved = resolve(path);
    const metadata = lstatSync(resolved);
    if (!resolved.startsWith(`${runnerTemp}${sep}`) || metadata.isSymbolicLink()) {
      throw new FixedSessionError("startup", "A Session runtime path is invalid.");
    }
    if (
      options.rclone && (path === options.rclone.configFile || path === options.rclone.mountsFile) &&
      (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    ) {
      throw new FixedSessionError("startup", "Rclone configuration file is invalid.");
    }
    if (
      options.database && (path === options.database.file || path === options.database.caFile) &&
      (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
    ) {
      throw new FixedSessionError("startup", "Database configuration file is invalid.");
    }
    if (path === options.sensitiveFactsFile && (!metadata.isFile() || (metadata.mode & 0o077) !== 0)) {
      throw new FixedSessionError("startup", "Sensitive Facts file is invalid.");
    }
  }
}

/** @param {SessionOptions} options @param {AbortController} shutdown */
async function runSession(options, shutdown) {
  validateRunnerTemporaryPaths(options);
  let rclone;
  if (options.rclone) {
    try {
      rclone = {
        configFile: options.rclone.configFile,
        mounts: parseRcloneMounts(readFileSync(options.rclone.mountsFile, "utf8")),
      };
    } catch {
      throw new FixedSessionError("startup", "Rclone mounts file is invalid.");
    }
  }
  console.log(`Starting Session: ${options.service}.`);
  console.log("Runtime artifacts are pinned; public validation remains separately gated.");

  const log = new BoundedLog(`${process.env.RUNNER_TEMP}/cloudflared.log`);
  const origin = SERVICE_ORIGINS[options.service];
  const cloudflaredArguments = [
    "tunnel", "--no-autoupdate", "--metrics", "127.0.0.1:49312",
    "--url", origin,
  ];
  const cloudflared = spawn(options.cloudflared, cloudflaredArguments, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  cloudflared.stdout.on("data", (chunk) => log.append(chunk));
  cloudflared.stderr.on("data", (chunk) => log.append(chunk));
  const cloudflaredExit = new Promise((resolvePromise) => {
    cloudflared.once("error", () => resolvePromise("error"));
    cloudflared.once("exit", (code) => resolvePromise(code));
  });

  const startupDeadline = new AbortController();
  const startupTimer = setTimeout(() => startupDeadline.abort(), STARTUP_TIMEOUT_MS);
  const serviceCancellation = AbortSignal.any([shutdown.signal, startupDeadline.signal]);
  let serviceRun;
  let ready = false;

  try {
    const sessionAddress = await Promise.race([
      obtainSessionAddress(cloudflared, serviceCancellation),
      exitAsFailure(cloudflaredExit, "cloudflared exited during startup."),
    ]);
    console.log("Startup stage complete: Quick Tunnel address.");
    serviceRun = runSelectedService({
      service: options.service,
      sessionAddress,
      credentialFile: options.credentialFile,
      cancellation: serviceCancellation,
      ...(rclone ? { rclone } : {}),
      ...(options.database ? { database: options.database } : {}),
    });
    const serviceReadyPromise = serviceRun.ready;
    const tunnelReadyPromise = waitForTunnelReady(cloudflared, serviceCancellation);
    let serviceReady;
    try {
      [serviceReady] = await Promise.race([
        Promise.all([serviceReadyPromise, tunnelReadyPromise]),
        exitAsFailure(cloudflaredExit, "cloudflared exited during startup."),
      ]);
    } catch (error) {
      if (startupDeadline.signal.aborted) {
        await serviceReadyPromise.catch((serviceError) => { throw serviceError; });
      }
      throw error;
    }
    clearTimeout(startupTimer);
    ready = true;
    writeReadySummary(options, sessionAddress, serviceReady);
    const artifactDirectory = process.env.GITHUB_WORKSPACE || process.env.RUNNER_TEMP;
    if (!artifactDirectory || !isAbsolute(artifactDirectory)) {
      throw new FixedSessionError("startup", "Locator Artifact directory is invalid.");
    }
    writeLocatorArtifact({
      address: sessionAddress,
      ...(serviceReady.username ? { username: serviceReady.username } : {}),
      ...(options.sensitiveFactsFile
        ? { sensitiveFacts: readSensitiveFactsBlock(options.sensitiveFactsFile) }
        : {}),
      directory: artifactDirectory,
    });
    console.log("Session Ready.");
    console.log(locatorBlock(sessionAddress, serviceReady.username).trimEnd());
    if (options.sensitiveFactsFile) console.log(readSensitiveFactsBlock(options.sensitiveFactsFile).trimEnd());

    await Promise.race([
      serviceFinishedAsFailure(serviceRun.finished),
      monitorTunnel(cloudflared, shutdown.signal),
      exitAsFailure(cloudflaredExit, "cloudflared exited while the Session was Ready."),
      waitForAbort(shutdown.signal),
    ]);
  } finally {
    clearTimeout(startupTimer);
    const shutdownWasRequested = shutdown.signal.aborted;
    shutdown.abort();
    const serviceResult = serviceRun
      ? await serviceRun.finished.catch(() => undefined)
      : undefined;
    await stopProcess(cloudflared, cloudflaredExit);
    try {
      unlinkSync(options.credentialFile);
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
        console.error("Selected Service credential cleanup was incomplete.");
      }
    }
    if (options.rclone) {
      for (const path of [options.rclone.configFile, options.rclone.mountsFile]) {
        try {
          unlinkSync(path);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            console.error("Rclone configuration cleanup was incomplete.");
          }
        }
      }
    }
    if (options.database) {
      for (const path of [options.database.file, options.database.caFile]) {
        try {
          unlinkSync(path);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            console.error("Database configuration cleanup was incomplete.");
          }
        }
      }
    }
    if (options.sensitiveFactsFile) {
      try {
        unlinkSync(options.sensitiveFactsFile);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          console.error("Sensitive Facts cleanup was incomplete.");
        }
      }
    }
    console.log(ready ? "Session terminated; cleanup completed." : "Session startup terminated; cleanup completed.");
    if (shutdownWasRequested && serviceResult && "phase" in serviceResult) {
      throw new FixedSessionError(serviceResult.phase, serviceResult.summary);
    }
  }
}

/** @param {import("node:child_process").ChildProcess} processHandle @param {AbortSignal} signal */
async function obtainSessionAddress(processHandle, signal) {
  while (!signal.aborted) {
    if (processHandle.exitCode !== null) {
      throw new FixedSessionError("startup", "cloudflared exited during startup.");
    }
    try {
      const response = await metricsRequest("/quicktunnel");
      const parsed = JSON.parse(response);
      const candidate = typeof parsed === "string" ? parsed : parsed.hostname ?? parsed.url;
      return validateSessionAddress(candidate);
    } catch (error) {
      if (error instanceof FixedSessionError) throw error;
      await delay(250, signal);
    }
  }
  throw new FixedSessionError("startup", "Quick Tunnel address was not ready.");
}

/** @param {unknown} candidate */
function validateSessionAddress(candidate) {
  try {
    if (typeof candidate !== "string") throw new Error();
    const address = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    if (
      address.protocol !== "https:" ||
      !address.hostname.endsWith(".trycloudflare.com") ||
      address.username || address.password ||
      address.pathname !== "/" || address.search || address.hash
    ) throw new Error();
    return address.origin;
  } catch {
    throw new FixedSessionError("startup", "cloudflared returned an invalid Session Address.");
  }
}

/** @param {import("node:child_process").ChildProcess} processHandle @param {AbortSignal} signal */
async function waitForTunnelReady(processHandle, signal) {
  while (!signal.aborted) {
    if (processHandle.exitCode !== null) throw new FixedSessionError("startup", "cloudflared exited during startup.");
    try {
      await metricsRequest("/ready");
      return;
    } catch {
      await delay(250, signal);
    }
  }
  throw new FixedSessionError("startup", "Quick Tunnel was not ready.");
}

/** @param {import("node:child_process").ChildProcess} processHandle @param {AbortSignal} signal */
async function monitorTunnel(processHandle, signal) {
  let unhealthySince;
  while (!signal.aborted) {
    if (processHandle.exitCode !== null) throw new FixedSessionError("runtime", "cloudflared exited while the Session was Ready.");
    try {
      await metricsRequest("/ready");
      unhealthySince = undefined;
    } catch {
      unhealthySince ??= Date.now();
      if (Date.now() - unhealthySince >= 30_000) {
        throw new FixedSessionError("runtime", "The Tunnel remained unhealthy.");
      }
    }
    await delay(1_000, signal);
  }
}

/** @param {string} path */
function metricsRequest(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.get(`${METRICS_ORIGIN}${path}`, { timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body = `${body}${chunk}`.slice(-16_384);
      });
      response.on("end", () => {
        if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) resolvePromise(body);
        else rejectPromise(new Error("metrics unhealthy"));
      });
    });
    request.on("timeout", () => request.destroy(new Error("metrics timeout")));
    request.on("error", rejectPromise);
  });
}

/** @param {SessionOptions} options @param {string} address @param {{ accessGuidance: string, username?: string }} ready */
function writeReadySummary(options, address, ready) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary || !isAbsolute(summary)) throw new FixedSessionError("startup", "Job Summary path is invalid.");
  const startedEpoch = Number(readFileSync(options.startedEpochFile, "utf8").trim());
  if (!Number.isSafeInteger(startedEpoch) || startedEpoch <= 0) {
    throw new FixedSessionError("startup", "Session start time is invalid.");
  }
  const readinessTime = new Date();
  const expectedExpiry = new Date((startedEpoch + 330 * 60) * 1_000);
  const lines = [
    "## Session Ready",
    "",
    `- Service: ${options.service}`,
    `- Ready at: ${readinessTime.toISOString()}`,
    `- Expected expiry: ${expectedExpiry.toISOString()}`,
    `- Access: ${ready.accessGuidance}`,
    "",
    locatorBlock(address, ready.username).trimEnd(),
  ];
  if (options.sensitiveFactsFile) lines.push("", readSensitiveFactsBlock(options.sensitiveFactsFile).trimEnd());
  writeFileSync(summary, `${lines.join("\n")}\n`, { mode: 0o600 });
}

/** @param {string} path */
function readSensitiveFactsBlock(path) {
  const block = readFileSync(path, "utf8");
  if (
    Buffer.byteLength(block, "utf8") > 16_384 ||
    !/^## Sensitive Facts\n\n(?:- [^:\r\n]{1,80}: enc:v2:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\n)+$/.test(block)
  ) {
    throw new FixedSessionError("startup", "Sensitive Facts file is invalid.");
  }
  return block;
}

/** @param {string} address @param {string | undefined} username */
function locatorBlock(address, username) {
  const lines = ["## Locators", "", `- Session Address: ${address}`];
  if (username) lines.push(`- Username: ${username}`);
  return [...lines, ""].join("\n");
}

/** @param {Promise<unknown>} exit @param {string} summary @returns {Promise<never>} */
async function exitAsFailure(exit, summary) {
  await exit;
  throw new FixedSessionError("runtime", summary);
}

/** @param {Promise<import("./service-module.mjs").ServiceResult>} finished */
async function serviceFinishedAsFailure(finished) {
  const result = await finished;
  if ("phase" in result) throw new FixedSessionError(result.phase, result.summary);
}

/** @param {AbortSignal} signal */
function waitForAbort(signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => signal.addEventListener("abort", () => resolvePromise(undefined), { once: true }));
}

/** @param {number} milliseconds @param {AbortSignal} signal */
function delay(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolvePromise(undefined);
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/** @param {import("node:child_process").ChildProcess} processHandle @param {Promise<unknown>} exit */
async function stopProcess(processHandle, exit) {
  if (processHandle.exitCode !== null) return;
  processHandle.kill("SIGTERM");
  let timeout;
  const timer = new Promise((resolvePromise) => {
    timeout = setTimeout(() => resolvePromise("timeout"), 10_000);
  });
  const result = await Promise.race([exit, timer]);
  clearTimeout(timeout);
  if (result === "timeout") processHandle.kill("SIGKILL");
}

/** @param {unknown} error */
function writeFailureSummary(error) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary || !isAbsolute(summary)) return;
  const failure = asFixedSessionError(error);
  writeFileSync(summary, [
    "## Session failed",
    "",
    `Phase: ${failure.phase}`,
    `Diagnostic: ${failure.summary}`,
    "",
  ].join("\n"), { mode: 0o600 });
}

/** @param {unknown} error */
function asFixedSessionError(error) {
  if (error instanceof FixedSessionError) return error;
  if (
    error && typeof error === "object" &&
    "phase" in error && ["startup", "runtime", "cleanup"].includes(String(error.phase)) &&
    "summary" in error && typeof error.summary === "string"
  ) {
    return new FixedSessionError(
      /** @type {"startup" | "runtime" | "cleanup"} */ (error.phase),
      error.summary,
    );
  }
  return new FixedSessionError("startup", "Session startup failed.");
}

const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => shutdown.abort());
}

try {
  const options = parseArguments(process.argv.slice(2));
  await runSession(options, shutdown);
} catch (error) {
  const failure = asFixedSessionError(error);
  writeFailureSummary(failure);
  console.error(failure.summary);
  process.exitCode = 1;
}
