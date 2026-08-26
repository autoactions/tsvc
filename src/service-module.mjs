import { spawn } from "node:child_process";
import { randomBytes, X509Certificate } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import { isSessionCredential } from "./session-credential.mjs";
import { isMotrixOperatorToken } from "./motrix-operator-token.mjs";
import { parseDatabase } from "./database.mjs";
import { isRcloneDestination, MOTRIX_DOWNLOADS_ROOT } from "./upload-destinations.mjs";

const ORIGIN_HOST = "127.0.0.1";
const ORIGIN_PORTS = { chrome: 58080, motrix: 58081, openlist: 58082 };
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const MAX_TASK_RESPONSE = 1024 * 1024;

const CHROME_IMAGE =
  "lscr.io/linuxserver/chrome@sha256:49a019a04b8d38422609d3c586636293417f61886704d516b7d5233cb4bd0b12";
const MOTRIX_IMAGE =
  "ghcr.io/agalwood/motrix-server@sha256:d3ecb7e7233d25ca1e947a386ee7c885f8c61fbabf7af4754a65d9d7fbdefa6f";
const OPENLIST_IMAGE =
  "openlistteam/openlist@sha256:b4de1e8e07de352a57e8f9eefbe5525c4a6eeef0ae4c74c2a1e68cb71d185fdb";
const RCLONE_IMAGE =
  "rclone/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548";

/** @typedef {"chrome" | "motrix" | "openlist"} Service */
/** @typedef {"startup" | "runtime" | "cleanup"} FailurePhase */
/** @typedef {{ phase: FailurePhase, summary: string }} ServiceFailure */
/** @typedef {{ accessGuidance: string }} ServiceReady */
/** @typedef {{ status: "success" } | ServiceFailure} ServiceResult */
/**
 * @typedef {{
 *   service: Service,
 *   sessionAddress: string,
 *   credentialFile: string,
 *   cancellation: AbortSignal,
 *   upload?: {
 *     rcloneConfigFile: string,
 *     destinations: { id: string, localRoot: string, destination: string }[],
 *   },
 *   database?: { file: string, caFile: string },
 * }} RunSelectedServiceOptions
 */
/** @typedef {{ ready: Promise<ServiceReady>, finished: Promise<ServiceResult> }} ServiceRun */

class FixedServiceError extends Error {
  /** @param {FailurePhase} phase @param {string} summary */
  constructor(phase, summary) {
    super(summary);
    this.phase = phase;
    this.summary = summary;
  }
}

class CommandExecutionError extends Error {
  /** @param {string} command @param {number | null} exitCode @param {string} output */
  constructor(command, exitCode, output) {
    super(`${command} failed`);
    this.exitCode = exitCode;
    this.output = output;
  }
}

/** @template T */
function deferred() {
  /** @type {(value: T) => void} */
  let resolvePromise = () => {};
  /** @type {(reason: unknown) => void} */
  let rejectPromise = () => {};
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

/**
 * The one public Service Module Interface. Adapter lifecycle and configuration
 * stay closed behind this function.
 *
 * @param {RunSelectedServiceOptions} options
 * @returns {ServiceRun}
 */
export function runSelectedService(options) {
  const ready = deferred();
  const finished = deferred();
  void runLifecycle(options, ready, finished);
  return { ready: ready.promise, finished: finished.promise };
}

/**
 * @param {RunSelectedServiceOptions} options
 * @param {ReturnType<typeof deferred<ServiceReady>>} ready
 * @param {ReturnType<typeof deferred<ServiceResult>>} finished
 */
async function runLifecycle(options, ready, finished) {
  /** @type {ServiceFailure | undefined} */
  let failure;
  let becameReady = false;
  /** @type {OwnedResources | undefined} */
  let resources;
  /** @type {string | undefined} */
  let ownedCredentialFile;
  /** @type {string | undefined} */
  let ownedRcloneConfigFile;
  /** @type {string | undefined} */
  let ownedDatabaseFile;
  /** @type {string | undefined} */
  let ownedDatabaseCaFile;
  /** @type {RcloneUploader | undefined} */
  let uploader;

  try {
    validateOptions(options);
    const locations = await validateTemporaryLocations(
      options.credentialFile,
      options.upload?.rcloneConfigFile,
      options.database?.file,
      options.database?.caFile,
    );
    ownedCredentialFile = locations.credentialFile;
    ownedRcloneConfigFile = locations.rcloneConfigFile;
    ownedDatabaseFile = locations.databaseFile;
    ownedDatabaseCaFile = locations.databaseCaFile;
    const credential = await readCredential(options.service, locations.credentialFile);
    const database = options.database && locations.databaseFile && locations.databaseCaFile
      ? await readDatabaseConfiguration(locations.databaseFile, locations.databaseCaFile)
      : undefined;
    resources = await createOwnedResources(
      options.service,
      locations.credentialFile,
      locations.runnerTemp,
      options.cancellation,
      options.upload && locations.rcloneConfigFile
        ? { rcloneConfigFile: locations.rcloneConfigFile, destinations: options.upload.destinations }
        : undefined,
      database,
    );
    await runCommand("docker", ["pull", resources.image], 10 * 60_000, options.cancellation);
    if (options.service === "motrix") {
      await prepareMotrixOperatorToken(resources, options.cancellation);
    }
    if (resources.upload) {
      await runCommand("docker", ["pull", RCLONE_IMAGE], 10 * 60_000, options.cancellation);
      await validateRcloneConfiguration(resources, options.cancellation);
    }
    await assertFreeSpace("startup");
    if (options.service === "openlist") {
      await prepareOpenList(resources, options.sessionAddress, options.cancellation);
    }
    await startAdapter(resources, options.sessionAddress, options.cancellation);
    const container = resources.container;
    const containerExit = waitForContainerExit(container);
    await Promise.race([
      waitForReadiness(resources, credential, options.sessionAddress, options.cancellation),
      containerExit.then(async () => {
        if (options.cancellation.aborted) return new Promise(() => {});
        if (options.service === "motrix") {
          await reportMotrixStartupExit(container, credential);
        }
        throw new FixedServiceError("startup", "Selected Service exited during startup.");
      }),
    ]);
    becameReady = true;
    ready.resolve({ accessGuidance: accessGuidance(options.service) });
    if (resources.upload) uploader = new RcloneUploader(resources, credential, options.cancellation);
    await Promise.race([
      supervise(resources, credential, options.sessionAddress, options.cancellation, uploader),
      containerExit.then(() => {
        if (options.cancellation.aborted) return new Promise(() => {});
        throw new FixedServiceError("runtime", "Selected Service exited.");
      }),
    ]);
  } catch (error) {
    failure = asServiceFailure(error, becameReady ? "runtime" : "startup");
    if (!becameReady) ready.reject(failure);
  } finally {
    await uploader?.stop();
    if (uploader?.hasUnresolvedFailures() && !failure) {
      failure = { phase: "runtime", summary: "Motrix upload or task cleanup remained incomplete." };
    }
    const cleanupFailed = await cleanup(resources, [
      ownedCredentialFile,
      ownedRcloneConfigFile,
      ownedDatabaseFile,
      ownedDatabaseCaFile,
    ]);
    if (cleanupFailed && !failure) {
      failure = { phase: "cleanup", summary: "Service cleanup incomplete." };
    }
    finished.resolve(failure ?? { status: "success" });
  }
}

/** @param {RunSelectedServiceOptions} options */
function validateOptions(options) {
  if (options.service !== "chrome" && options.service !== "motrix" && options.service !== "openlist") {
    throw new FixedServiceError("startup", "Selected Service is invalid.");
  }
  if (!isAbsolute(options.credentialFile)) {
    throw new FixedServiceError("startup", "Selected Service credential file is invalid.");
  }
  if (
    (options.service === "motrix" && !options.upload) ||
    (options.service !== "motrix" && options.upload) ||
    (options.upload && (
      !isAbsolute(options.upload.rcloneConfigFile) ||
      !validUploadDestinations(options.upload.destinations)
    ))
  ) {
    throw new FixedServiceError("startup", "Selected Service upload configuration is invalid.");
  }
  if (
    (options.service === "openlist" && !options.database) ||
    (options.service !== "openlist" && options.database) ||
    (options.database && (!isAbsolute(options.database.file) || !isAbsolute(options.database.caFile)))
  ) {
    throw new FixedServiceError("startup", "Selected Service database configuration is invalid.");
  }
  try {
    const address = new URL(options.sessionAddress);
    if (!/^https?:$/.test(address.protocol) || address.username || address.password) {
      throw new Error();
    }
  } catch {
    throw new FixedServiceError("startup", "Session Address is invalid.");
  }
}

/** @param {Service} service */
function originPort(service) {
  return ORIGIN_PORTS[service];
}

/** @param {unknown} destinations */
function validUploadDestinations(destinations) {
  if (!Array.isArray(destinations) || destinations.length === 0) return false;
  const ids = new Set();
  return destinations.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = /** @type {Record<string, unknown>} */ (entry);
    if (
      typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.id) ||
      ids.has(value.id) || value.localRoot !== join(MOTRIX_DOWNLOADS_ROOT, value.id) ||
      !isRcloneDestination(value.destination)
    ) return false;
    ids.add(value.id);
    return true;
  });
}

/** @param {Service} service @param {string} path */
async function readCredential(service, path) {
  const metadata = await lstat(path).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new FixedServiceError("startup", "Selected Service credential file is invalid.");
  }
  const value = await readFile(path, "utf8");
  const valid = service === "chrome"
    ? isSessionCredential(value)
    : service === "openlist"
      ? isSessionCredential(value) && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value)
      : isMotrixOperatorToken(value);
  if (!valid) {
    throw new FixedServiceError("startup", "Selected Service credential file is invalid.");
  }
  return value;
}

class OwnedResources {
  /**
   * @param {Service} service
   * @param {string} credentialFile
   * @param {string} tempRoot
   * @param {{ rcloneConfigFile: string, destinations: { id: string, localRoot: string, destination: string }[] } | undefined} upload
   * @param {{ connection: { host: string, port: number, user: string, password: string }, caFile: string } | undefined} database
   */
  constructor(service, credentialFile, tempRoot, upload, database) {
    this.service = service;
    this.credentialFile = credentialFile;
    this.tempRoot = tempRoot;
    this.suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
    this.container = `temporary-session-${service}-${this.suffix}`;
    this.tokenPreparationContainer = `${this.container}-token-permissions`;
    this.openlistPermissionContainer = `${this.container}-openlist-permissions`;
    this.openlistConfigurationContainer = `${this.container}-openlist-configuration`;
    this.openlistBootstrapContainer = `${this.container}-openlist-bootstrap`;
    this.image = service === "chrome" ? CHROME_IMAGE : service === "motrix" ? MOTRIX_IMAGE : OPENLIST_IMAGE;
    this.upload = upload
      ? {
          ...upload,
          configDirectory: join(tempRoot, "rclone-config"),
          privateConfigFile: join(tempRoot, "rclone-config", "rclone.conf"),
        }
      : undefined;
    this.database = database
      ? {
          ...database,
          privateCaFile: join(tempRoot, "database-ca.pem"),
        }
      : undefined;
    this.openlistConfigFile = service === "openlist" ? join(tempRoot, "openlist-config.json") : undefined;
    this.volumes = service === "chrome"
      ? [`temporary-session-chrome-config-${this.suffix}`]
      : service === "motrix" ? [
          `temporary-session-motrix-data-${this.suffix}`,
          `temporary-session-motrix-downloads-${this.suffix}`,
        ] : [`temporary-session-openlist-data-${this.suffix}`];
  }
}

/** @param {OwnedResources} resources @param {AbortSignal} cancellation */
async function prepareMotrixOperatorToken(resources, cancellation) {
  await runCommand("docker", [
    "run", "--rm",
    "--name", resources.tokenPreparationContainer,
    "--user", "0:0",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--cap-add", "CHOWN",
    "--security-opt", "no-new-privileges",
    "--mount", `type=bind,source=${resources.credentialFile},target=/run/secrets/motrix-operator-token`,
    "--entrypoint", "/bin/sh",
    resources.image,
    "-c",
    'chown 1000:1000 "$1" && [ "$(stat -c \'%u:%g:%a\' "$1")" = "1000:1000:600" ]',
    "--",
    "/run/secrets/motrix-operator-token",
  ], 60_000, cancellation).catch(() => {
    throw new FixedServiceError("startup", "Motrix Operator Token permission setup failed.");
  });
}

/** @param {OwnedResources} resources @param {string} sessionAddress @param {AbortSignal} cancellation */
async function prepareOpenList(resources, sessionAddress, cancellation) {
  const database = resources.database;
  const generatedConfigFile = resources.openlistConfigFile;
  const [stateVolume] = resources.volumes;
  if (!database || !generatedConfigFile || !stateVolume) throw new Error("missing OpenList configuration");
  const config = {
    force: true,
    site_url: sessionAddress,
    jwt_secret: randomBytes(32).toString("hex"),
    database: {
      type: "mysql",
      host: database.connection.host,
      port: database.connection.port,
      user: database.connection.user,
      password: database.connection.password,
      name: "openlist",
      db_file: "",
      table_prefix: "x_",
      ssl_mode: "true",
      dsn: "",
    },
    scheme: {
      address: "0.0.0.0",
      http_port: 5244,
      https_port: -1,
      force_https: false,
    },
    temp_dir: "/tmp/openlist-temp",
    bleve_dir: "/tmp/openlist-bleve",
    log: { enable: false },
  };
  await writeFile(generatedConfigFile, JSON.stringify(config), { mode: 0o600 });

  await runCommand("docker", [
    "run", "--rm",
    "--name", resources.openlistPermissionContainer,
    "--user", "0:0",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--cap-add", "CHOWN",
    "--security-opt", "no-new-privileges",
    "--mount", `type=volume,source=${stateVolume},target=/state`,
    "--mount", `type=bind,source=${resources.credentialFile},target=/run/secrets/session-credential`,
    "--mount", `type=bind,source=${generatedConfigFile},target=/run/secrets/openlist-config`,
    "--mount", `type=bind,source=${database.privateCaFile},target=/run/secrets/openlist-database-ca`,
    "--entrypoint", "/bin/sh",
    resources.image,
    "-c",
    'chown 1001:1001 "$1" "$2" "$3" "$4" && [ "$(stat -c \'%u:%g:%a\' "$1")" = "1001:1001:600" ] && [ "$(stat -c \'%u:%g:%a\' "$2")" = "1001:1001:600" ] && [ "$(stat -c \'%u:%g:%a\' "$3")" = "1001:1001:600" ]',
    "--",
    "/run/secrets/session-credential",
    "/run/secrets/openlist-config",
    "/run/secrets/openlist-database-ca",
    "/state",
  ], 60_000, cancellation).catch(() => {
    throw new FixedServiceError("startup", "OpenList configuration permission setup failed.");
  });

  await runCommand("docker", [
    "run", "--rm",
    "--name", resources.openlistConfigurationContainer,
    "--user", "1001:1001",
    "--network", "none",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--mount", `type=volume,source=${stateVolume},target=/state`,
    "--mount", `type=bind,source=${generatedConfigFile},target=/run/secrets/openlist-config,readonly`,
    "--mount", `type=bind,source=${database.privateCaFile},target=/run/secrets/openlist-database-ca,readonly`,
    "--entrypoint", "/bin/sh",
    resources.image,
    "-c",
    'cp "$1" /state/config.json && cp "$2" /state/database-ca.pem && chmod 600 /state/config.json /state/database-ca.pem',
    "--",
    "/run/secrets/openlist-config",
    "/run/secrets/openlist-database-ca",
  ], 60_000, cancellation).catch(() => {
    throw new FixedServiceError("startup", "OpenList configuration setup failed.");
  });

  await runCommand("docker", [
    "run", "--rm",
    "--name", resources.openlistBootstrapContainer,
    "--user", "1001:1001",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--env", "SSL_CERT_FILE=/opt/openlist/data/database-ca.pem",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m",
    "--mount", `type=volume,source=${stateVolume},target=/opt/openlist/data`,
    "--mount", `type=bind,source=${resources.credentialFile},target=/run/secrets/session-credential,readonly`,
    "--entrypoint", "/bin/sh",
    resources.image,
    "-c",
    'OPENLIST_ADMIN_PASSWORD="$(cat /run/secrets/session-credential)" || exit 64; [ -n "$OPENLIST_ADMIN_PASSWORD" ] || exit 65; export OPENLIST_ADMIN_PASSWORD; exec ./openlist admin',
  ], 120_000, cancellation).catch(() => {
    throw new FixedServiceError("startup", "OpenList database bootstrap failed.");
  });
}

/**
 * @param {string} credentialFile
 * @param {string | undefined} rcloneConfigFile
 * @param {string | undefined} databaseFile
 * @param {string | undefined} databaseCaFile
 */
async function validateTemporaryLocations(
  credentialFile,
  rcloneConfigFile,
  databaseFile,
  databaseCaFile,
) {
  const runnerTemp = resolve(process.env.RUNNER_TEMP || tmpdir());
  const runnerTempReal = await realpath(runnerTemp);
  const metadata = await lstat(credentialFile).catch(() => undefined);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    throw new FixedServiceError("startup", "Selected Service credential file is invalid.");
  }
  const credentialReal = await realpath(credentialFile);
  if (!within(credentialReal, runnerTempReal)) {
    throw new FixedServiceError("startup", "Selected Service credential file is outside runner-temporary storage.");
  }
  let rcloneConfigReal;
  if (rcloneConfigFile) {
    const rcloneMetadata = await lstat(rcloneConfigFile).catch(() => undefined);
    if (
      !rcloneMetadata?.isFile() || rcloneMetadata.isSymbolicLink() ||
      (rcloneMetadata.mode & 0o077) !== 0 || rcloneMetadata.size === 0
    ) {
      throw new FixedServiceError("startup", "Rclone configuration file is invalid.");
    }
    rcloneConfigReal = await realpath(rcloneConfigFile);
    if (!within(rcloneConfigReal, runnerTempReal)) {
      throw new FixedServiceError("startup", "Rclone configuration file is outside runner-temporary storage.");
    }
  }
  const databaseReal = databaseFile
    ? await validateDatabaseTemporaryFile(databaseFile, runnerTempReal)
    : undefined;
  const databaseCaReal = databaseCaFile
    ? await validateDatabaseTemporaryFile(databaseCaFile, runnerTempReal)
    : undefined;
  return {
    credentialFile: credentialReal,
    rcloneConfigFile: rcloneConfigReal,
    databaseFile: databaseReal,
    databaseCaFile: databaseCaReal,
    runnerTemp: runnerTempReal,
  };
}

/** @param {string} path @param {string} runnerTemp */
async function validateDatabaseTemporaryFile(path, runnerTemp) {
  const metadata = await lstat(path).catch(() => undefined);
  if (
    !metadata?.isFile() || metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 || metadata.size === 0
  ) {
    throw new FixedServiceError("startup", "Database configuration file is invalid.");
  }
  const real = await realpath(path);
  if (!within(real, runnerTemp)) {
    throw new FixedServiceError("startup", "Database configuration file is outside runner-temporary storage.");
  }
  return real;
}

/** @param {string} databaseFile @param {string} databaseCaFile */
async function readDatabaseConfiguration(databaseFile, databaseCaFile) {
  let connection;
  try {
    connection = parseDatabase(await readFile(databaseFile, "utf8"));
  } catch {
    throw new FixedServiceError("startup", "Database configuration is invalid.");
  }
  const ca = await readFile(databaseCaFile, "utf8");
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  try {
    if (!certificates || certificates.join("\n").trim() !== ca.trim()) throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
  } catch {
    throw new FixedServiceError("startup", "Database CA is invalid.");
  }
  return { connection, caFile: databaseCaFile };
}

/**
 * @param {Service} service
 * @param {string} credentialFile
 * @param {string} runnerTemp
 * @param {AbortSignal} cancellation
 * @param {{ rcloneConfigFile: string, destinations: { id: string, localRoot: string, destination: string }[] } | undefined} upload
 * @param {{ connection: { host: string, port: number, user: string, password: string }, caFile: string } | undefined} database
 */
async function createOwnedResources(service, credentialFile, runnerTemp, cancellation, upload, database) {
  const tempRoot = await mkdtemp(join(runnerTemp, "temporary-session-"));
  await chmod(tempRoot, 0o700);
  const resources = new OwnedResources(service, credentialFile, tempRoot, upload, database);
  /** @type {string[]} */
  const createdVolumes = [];
  try {
    if (resources.upload) {
      await mkdir(resources.upload.configDirectory, { mode: 0o700 });
      await copyFile(resources.upload.rcloneConfigFile, resources.upload.privateConfigFile);
      await chmod(resources.upload.privateConfigFile, 0o600);
    }
    if (resources.database) {
      await copyFile(resources.database.caFile, resources.database.privateCaFile);
      await chmod(resources.database.privateCaFile, 0o600);
    }
    for (const volume of resources.volumes) {
      await runCommand("docker", ["volume", "create", volume], 60_000, cancellation);
      createdVolumes.push(volume);
    }
  } catch {
    for (const volume of createdVolumes) {
      await runCommand("docker", ["volume", "rm", volume], 30_000).catch(() => undefined);
    }
    await rm(tempRoot, { recursive: true }).catch(() => undefined);
    throw new FixedServiceError("startup", "Selected Service storage setup failed.");
  }
  return resources;
}

/** @param {string} child @param {string} parent */
function within(child, parent) {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/** @param {OwnedResources} resources */
function commonRcloneDockerArgs(resources) {
  if (!resources.upload) throw new Error("missing upload configuration");
  const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
  const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
  return [
    "run", "--rm",
    "--user", `${uid}:${gid}`,
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--network", "bridge",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--mount", `type=bind,source=${resources.upload.configDirectory},target=/config/rclone`,
  ];
}

/** @param {OwnedResources} resources @param {AbortSignal} cancellation */
async function validateRcloneConfiguration(resources, cancellation) {
  if (!resources.upload) return;
  const output = await runCommand("docker", [
    ...commonRcloneDockerArgs(resources),
    "--name", `${resources.container}-rclone-config-check`,
    RCLONE_IMAGE,
    "--config", "/config/rclone/rclone.conf",
    "listremotes",
  ], 60_000, cancellation).catch(() => {
    throw new FixedServiceError("startup", "Rclone configuration validation failed.");
  });
  const configured = new Set(output.split(/\r?\n/));
  const remotes = resources.upload.destinations.map(({ destination }) =>
    destination.slice(0, destination.indexOf(":"))
  );
  if (remotes.some((remote) => !configured.has(`${remote}:`))) {
    throw new FixedServiceError("startup", "Rclone Destination remote is not configured.");
  }
}

class RcloneUploader {
  /** @param {OwnedResources} resources @param {string} credential @param {AbortSignal} cancellation */
  constructor(resources, credential, cancellation) {
    this.resources = resources;
    this.credential = credential;
    this.controller = new AbortController();
    this.signal = AbortSignal.any([cancellation, this.controller.signal]);
    /** @type {{ item: number, taskId: string, source: string, destination: string, destinationId: string, isBt: boolean, phase: "upload" | "stop-seeding" | "remove", failures: number, availableAt: number }[]} */
    this.queue = [];
    this.queued = new Set();
    this.completed = new Set();
    this.failed = new Set();
    this.nextItem = 1;
    /** @type {Promise<void> | undefined} */
    this.worker = undefined;
  }

  /** @param {unknown[]} tasks */
  observe(tasks) {
    const upload = this.resources.upload;
    if (!upload) return;
    for (const task of tasks) {
      const candidate = uploadCandidate(task, upload.destinations);
      if (!candidate || this.queued.has(candidate.taskId) || this.completed.has(candidate.taskId)) continue;
      this.queued.add(candidate.taskId);
      const entry = {
        ...candidate,
        item: this.nextItem++,
        phase: /** @type {const} */ ("upload"),
        failures: 0,
        availableAt: Date.now(),
      };
      this.queue.push(entry);
      console.log(`Rclone upload queued (item ${entry.item}, destination ${entry.destinationId}).`);
    }
    if (this.queue.length > 0 && !this.worker) {
      this.worker = this.run().finally(() => { this.worker = undefined; });
    }
  }

  async run() {
    while (!this.signal.aborted && this.queue.length > 0) {
      const now = Date.now();
      const index = this.queue.findIndex((entry) => entry.availableAt <= now);
      if (index < 0) {
        const next = Math.min(...this.queue.map((entry) => entry.availableAt));
        await abortableDelay(Math.min(1_000, Math.max(1, next - now)), this.signal);
        continue;
      }
      const [entry] = this.queue.splice(index, 1);
      if (!entry) continue;
      try {
        if (entry.phase === "upload") {
          await uploadWithRclone(this.resources, entry.source, entry.destination, this.signal);
          entry.phase = entry.isBt ? "stop-seeding" : "remove";
          entry.failures = 0;
          console.log(`Rclone upload completed (item ${entry.item}, destination ${entry.destinationId}).`);
        }
        if (entry.phase === "stop-seeding") {
          await invokeMotrixCommand("command:stopSeedingTask", [entry.taskId], this.credential, this.signal);
          entry.phase = "remove";
          entry.failures = 0;
        }
        await invokeMotrixCommand(
          "command:removeTask",
          [{ taskId: entry.taskId, deleteWithFiles: true }],
          this.credential,
          this.signal,
        );
        this.queued.delete(entry.taskId);
        this.failed.delete(entry.taskId);
        this.completed.add(entry.taskId);
        console.log(`Motrix task cleanup completed (item ${entry.item}).`);
      } catch (error) {
        if (this.signal.aborted) break;
        entry.failures += 1;
        this.failed.add(entry.taskId);
        if (entry.phase === "upload") {
          const failure = classifyRcloneFailure(error);
          const exit = failure.exitCode === undefined ? "unavailable" : String(failure.exitCode);
          const prefix = `Rclone upload failed (item ${entry.item}, destination ${entry.destinationId}, attempt ${entry.failures}, category ${failure.category}, exit ${exit})`;
          if (failure.permanent) {
            console.log(`${prefix}; no retry scheduled.`);
            continue;
          }
          const delay = retryDelay(entry.failures);
          entry.availableAt = Date.now() + delay;
          this.queue.push(entry);
          console.log(`${prefix}; retry scheduled in ${Math.max(1, Math.ceil(delay / 1_000))}s.`);
          continue;
        }
        const delay = retryDelay(entry.failures);
        entry.availableAt = Date.now() + delay;
        this.queue.push(entry);
        console.log(`Motrix task cleanup failed (item ${entry.item}, attempt ${entry.failures}); retry scheduled in ${Math.max(1, Math.ceil(delay / 1_000))}s.`);
      }
    }
  }

  async stop() {
    this.controller.abort();
    await this.worker?.catch(() => undefined);
  }

  hasUnresolvedFailures() {
    return this.failed.size > 0;
  }
}

/** @param {number} failures */
function retryDelay(failures) {
  const ceiling = Math.min(60_000, 1_000 * (2 ** Math.min(failures - 1, 6)));
  return Math.max(1, Math.round(ceiling * (0.5 + (Math.random() * 0.5))));
}

/**
 * @param {unknown} error
 * @returns {{ category: "temporary" | "auth" | "permission" | "quota" | "path-conflict" | "source-missing" | "fatal" | "unknown", exitCode: number | undefined, permanent: boolean }}
 */
function classifyRcloneFailure(error) {
  const exitCode = error instanceof CommandExecutionError && typeof error.exitCode === "number"
    ? error.exitCode
    : undefined;
  const output = error instanceof CommandExecutionError ? error.output.toLowerCase() : "";
  /** @type {"temporary" | "auth" | "permission" | "quota" | "path-conflict" | "source-missing" | "fatal" | "unknown"} */
  let category;
  if (/\b429\b|too many requests|rate.?limit|throttl/.test(output)) category = "temporary";
  else if (/\b408\b|\b423\b|\b5\d\d\b|timed? out|timeout|connection reset|temporar|try again/.test(output)) category = "temporary";
  else if (/\b401\b|unauthori[sz]ed|invalid_grant|token[^\n]*(?:expired|invalid)/.test(output)) category = "auth";
  else if (/\b403\b|forbidden|permission denied|access denied/.test(output)) category = "permission";
  else if (/\b507\b|quota|insufficient storage|storage limit/.test(output)) category = "quota";
  else if (/\b409\b|case.?insensitive|invalid (?:file)?name|name[^\n]*invalid|already exists|conflict/.test(output)) category = "path-conflict";
  else if (/no such file|not found|directory not found/.test(output)) category = "source-missing";
  else if (exitCode === 5) category = "temporary";
  else if (exitCode === 3 || exitCode === 4) category = "source-missing";
  else if (exitCode === 8) category = "quota";
  else if ([2, 6, 7].includes(exitCode ?? -1)) category = "fatal";
  else category = "unknown";
  return {
    category,
    exitCode,
    permanent: ["auth", "permission", "quota", "path-conflict", "source-missing", "fatal"].includes(category),
  };
}

/** @param {unknown} task @param {{ id: string, localRoot: string, destination: string }[]} destinations */
function uploadCandidate(task, destinations) {
  if (!task || typeof task !== "object") return undefined;
  const value = /** @type {Record<string, unknown>} */ (task);
  if (
    typeof value.id !== "string" ||
    !["seeding", "completed"].includes(String(value.status)) ||
    value.transitionPhase !== "idle" ||
    typeof value.finalPath !== "string"
  ) return undefined;
  const source = resolve(value.finalPath);
  const target = destinations.find(({ localRoot }) => within(source, resolve(localRoot)));
  if (!target) return undefined;
  const localRoot = resolve(target.localRoot);
  if (source === localRoot) return undefined;
  const relative = source.slice(localRoot.length + 1).split(sep).join("/");
  if (!relative || relative.startsWith("../") || relative.includes("/../")) return undefined;
  const prefix = target.destination.endsWith(":")
    ? target.destination
    : `${target.destination.replace(/\/+$/, "")}/`;
  return {
    taskId: value.id,
    source,
    destination: `${prefix}${relative}`,
    destinationId: target.id,
    isBt: value.type === "bt" || value.type === "magnet" || value.kind === "bt" || value.status === "seeding",
  };
}

/** @param {string} channel @param {unknown[]} args @param {string} credential @param {AbortSignal} cancellation */
async function invokeMotrixCommand(channel, args, credential, cancellation) {
  await httpJson(
    `http://${ORIGIN_HOST}:${originPort("motrix")}/rpc/command/${encodeURIComponent(channel)}`,
    { authorization: `Bearer ${credential}` },
    "POST",
    JSON.stringify({ args }),
    cancellation,
  );
}

/** @param {OwnedResources} resources @param {string} source @param {string} destination @param {AbortSignal} cancellation */
async function uploadWithRclone(resources, source, destination, cancellation) {
  await runCommand("docker", [
    ...commonRcloneDockerArgs(resources),
    "--name", `${resources.container}-rclone-upload`,
    "--mount", `type=volume,source=${resources.volumes[1]},target=/downloads,readonly`,
    RCLONE_IMAGE,
    "--config", "/config/rclone/rclone.conf",
    "copyto", source, destination,
    "--retries", "3",
    "--low-level-retries", "10",
    "--retries-sleep", "10s",
    "--use-json-log",
    "--log-level", "ERROR",
    "--stats", "0",
  ], 0, cancellation);
}

/** @param {OwnedResources} resources @param {string} sessionAddress @param {AbortSignal} cancellation */
async function startAdapter(resources, sessionAddress, cancellation) {
  const args = resources.service === "chrome"
    ? chromeDockerArgs(resources)
    : resources.service === "motrix"
      ? motrixDockerArgs(resources, sessionAddress)
      : openlistDockerArgs(resources);
  await runCommand("docker", args, 60_000, cancellation);
}

/** @param {OwnedResources} resources */
function commonDockerArgs(resources) {
  return [
    "run",
    "--detach",
    "--name", resources.container,
    "--log-driver", "local",
    "--log-opt", "max-size=10m",
    "--log-opt", "max-file=3",
    "--publish",
    `${ORIGIN_HOST}:${originPort(resources.service)}:${containerPort(resources.service)}`,
    "--restart", "no",
  ];
}

/** @param {Service} service */
function containerPort(service) {
  return service === "chrome" ? 3000 : service === "motrix" ? 8080 : 5244;
}

/** @param {OwnedResources} resources */
function chromeDockerArgs(resources) {
  return [
    ...commonDockerArgs(resources),
    "--shm-size", "1g",
    "--env", "START_DOCKER=false",
    "--env", "CUSTOM_USER=session",
    "--env", "FILE__PASSWORD=/run/secrets/session-credential",
    "--mount", `type=volume,source=${resources.volumes[0]},target=/config`,
    "--mount", `type=bind,source=${resources.credentialFile},target=/run/secrets/session-credential,readonly`,
    resources.image,
  ];
}

/** @param {OwnedResources} resources @param {string} sessionAddress */
function motrixDockerArgs(resources, sessionAddress) {
  if (!resources.upload) throw new Error("missing upload configuration");
  const [defaultDestination] = resources.upload.destinations;
  if (!defaultDestination) throw new Error("missing upload destinations");
  return [
    ...commonDockerArgs(resources),
    "--user", "1000:1000",
    "--read-only",
    "--init",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--env", `MOTRIX_PUBLIC_URL=${sessionAddress}`,
    "--env", `MOTRIX_DEFAULT_SAVE_DIR=${defaultDestination.localRoot}`,
    "--env", `MOTRIX_ALLOWED_SAVE_DIRS=${resources.upload.destinations.map(({ localRoot }) => localRoot).join(":")}`,
    "--entrypoint", "/bin/sh",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--stop-timeout", "120",
    "--mount", `type=volume,source=${resources.volumes[0]},target=/data`,
    "--mount", `type=volume,source=${resources.volumes[1]},target=/downloads`,
    "--mount", `type=bind,source=${resources.credentialFile},target=/run/secrets/motrix-operator-token,readonly`,
    resources.image,
    "-c",
    'MOTRIX_OPERATOR_TOKEN="$(cat /run/secrets/motrix-operator-token)" || { echo "Motrix bootstrap could not read the operator token file." >&2; exit 64; }; [ -n "$MOTRIX_OPERATOR_TOKEN" ] || { echo "Motrix bootstrap received an empty operator token." >&2; exit 65; }; export MOTRIX_OPERATOR_TOKEN; exec docker-entrypoint.sh "$@"',
    "--",
    "node",
    "dist/server/index.mjs",
  ];
}

/** @param {OwnedResources} resources */
function openlistDockerArgs(resources) {
  const [stateVolume] = resources.volumes;
  if (!resources.database || !stateVolume) throw new Error("missing OpenList configuration");
  return [
    ...commonDockerArgs(resources),
    "--user", "1001:1001",
    "--read-only",
    "--init",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--env", "RUN_ARIA2=true",
    "--env", "SSL_CERT_FILE=/opt/openlist/data/database-ca.pem",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
    "--mount", `type=volume,source=${stateVolume},target=/opt/openlist/data`,
    resources.image,
  ];
}

/**
 * @param {OwnedResources} resources
 * @param {string} credential
 * @param {string} sessionAddress
 * @param {AbortSignal} cancellation
 */
async function waitForReadiness(resources, credential, sessionAddress, cancellation) {
  while (!cancellation.aborted) {
    if (!(await containerRunning(resources.container, cancellation))) {
      if (cancellation.aborted) break;
      if (resources.service === "motrix") {
        await reportMotrixStartupExit(resources.container, credential);
      }
      throw new FixedServiceError("startup", "Selected Service exited during startup.");
    }
    try {
      await requiredHealth(resources.service, credential, sessionAddress);
      return;
    } catch {
      await abortableDelay(1_000, cancellation);
    }
  }
  throw new FixedServiceError("startup", "Session startup was cancelled.");
}

/**
 * @param {OwnedResources} resources
 * @param {string} credential
 * @param {string} sessionAddress
 * @param {AbortSignal} cancellation
 * @param {RcloneUploader | undefined} uploader
 */
async function supervise(resources, credential, sessionAddress, cancellation, uploader) {
  let unhealthySince;
  while (!cancellation.aborted) {
    if (!(await containerRunning(resources.container, cancellation))) {
      if (cancellation.aborted) break;
      throw new FixedServiceError("runtime", "Selected Service exited.");
    }
    await assertFreeSpace();
    try {
      const tasks = await requiredHealth(resources.service, credential, sessionAddress);
      if (uploader && tasks) uploader.observe(tasks);
      unhealthySince = undefined;
    } catch {
      unhealthySince ??= Date.now();
      if (Date.now() - unhealthySince >= 30_000) {
        throw new FixedServiceError("runtime", "A required Service health signal remained unhealthy.");
      }
    }
    await abortableDelay(1_000, cancellation);
  }
}

/** @param {string} credential */
async function queryMotrixTasks(credential) {
  const value = await httpJson(
    `http://${ORIGIN_HOST}:${originPort("motrix")}/rpc/query/query%3AlistTasks`,
    { authorization: `Bearer ${credential}` },
    "POST",
    '{"args":[]}',
  );
  if (!Array.isArray(value)) throw new Error("unhealthy");
  return value;
}

/** @param {Service} service @param {string} credential @param {string} sessionAddress */
async function requiredHealth(service, credential, sessionAddress) {
  const localBase = `http://${ORIGIN_HOST}:${originPort(service)}`;
  if (service === "chrome") {
    const authorization = `Basic ${Buffer.from(`session:${credential}`).toString("base64")}`;
    await Promise.all([
      httpStatus(`${localBase}/`, { authorization }),
      httpStatus(`${sessionAddress}/`, { authorization }),
      websocketUpgrade(`${sessionAddress}/websocket`, { authorization }),
    ]);
    return;
  }
  if (service === "openlist") {
    const login = await httpJson(
      `${localBase}/api/auth/login`,
      {},
      "POST",
      JSON.stringify({ username: "admin", password: credential }),
    );
    if (
      !login || typeof login !== "object" ||
      /** @type {Record<string, unknown>} */ (login).code !== 200 ||
      !/** @type {{ data?: { token?: unknown } }} */ (login).data ||
      typeof /** @type {{ data: { token?: unknown } }} */ (login).data.token !== "string"
    ) throw new Error("unhealthy");
    await httpStatus(`${sessionAddress}/`, {});
    return;
  }
  const [, tasks] = await Promise.all([
    httpStatus(`${localBase}/healthz`, {}),
    queryMotrixTasks(credential),
  ]);
  return tasks;
}

/** @param {string} url @param {Record<string, string>} headers @param {string} [method] @param {string} [body] */
function httpStatus(url, headers, method = "GET", body) {
  /** @type {Promise<void>} */
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(parsed, {
      headers: body ? { ...headers, "content-length": String(Buffer.byteLength(body)), "content-type": "application/json" } : headers,
      method,
      timeout: 5_000,
    }, (response) => {
      response.resume();
      if ((response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300) resolvePromise(undefined);
      else rejectPromise(new Error("unhealthy"));
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", rejectPromise);
    if (body) request.write(body);
    request.end();
  });
}

/** @param {string} url @param {Record<string, string>} headers @param {string} method @param {string} body @param {AbortSignal} [signal] */
function httpJson(url, headers, method, body, signal) {
  /** @type {Promise<unknown>} */
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(parsed, {
      headers: {
        ...headers,
        "content-length": String(Buffer.byteLength(body)),
        "content-type": "application/json",
      },
      method,
      timeout: 5_000,
    }, (response) => {
      let output = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        output += chunk;
        if (output.length > MAX_TASK_RESPONSE) response.destroy(new Error("response too large"));
      });
      response.on("end", () => {
        signal?.removeEventListener("abort", cancel);
        if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
          rejectPromise(new Error("unhealthy"));
          return;
        }
        try {
          resolvePromise(JSON.parse(output));
        } catch {
          rejectPromise(new Error("unhealthy"));
        }
      });
    });
    const cancel = () => request.destroy(new Error("cancelled"));
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error) => {
      signal?.removeEventListener("abort", cancel);
      rejectPromise(error);
    });
    if (signal) {
      if (signal.aborted) cancel();
      else signal.addEventListener("abort", cancel, { once: true });
    }
    request.write(body);
    request.end();
  });
}

/** @param {string} url @param {Record<string, string>} headers */
function websocketUpgrade(url, headers) {
  /** @type {Promise<void>} */
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(parsed, {
      headers: {
        ...headers,
        connection: "Upgrade",
        upgrade: "websocket",
        "sec-websocket-key": randomBytes(16).toString("base64"),
        "sec-websocket-version": "13",
      },
      timeout: 5_000,
    });
    request.once("upgrade", (_response, socket) => {
      socket.destroy();
      resolvePromise(undefined);
    });
    request.once("response", (response) => {
      response.resume();
      rejectPromise(new Error("upgrade rejected"));
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", rejectPromise);
    request.end();
  });
}

/** @param {string} container @param {AbortSignal} cancellation */
async function containerRunning(container, cancellation) {
  try {
    const output = await runCommand("docker", ["inspect", "--format", "{{.State.Running}}", container], 5_000, cancellation);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

/** @param {string} container */
function waitForContainerExit(container) {
  return new Promise((resolvePromise) => {
    const child = spawn("docker", ["wait", container], {
      env: process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", () => resolvePromise(undefined));
    child.once("close", () => resolvePromise(undefined));
  });
}

/** @param {string} container @param {string} credential */
async function reportMotrixStartupExit(container, credential) {
  const state = await runCommand("docker", [
    "inspect",
    "--format",
    "exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{json .State.Error}}",
    container,
  ], 5_000).catch(() => "state unavailable");
  const logs = await runCommand("docker", ["logs", "--tail", "80", container], 5_000)
    .catch(() => "");
  const redacted = (credential ? logs.split(credential).join("<REDACTED>") : logs)
    .replace(/((?:authorization|password|secret|token)["']?\s*[:=]\s*["']?)[^\s,"'}]+/giu, "$1<REDACTED>");
  const relevant = redacted
    .split(/\r?\n/u)
    .filter((/** @type {string} */ line) => /bootstrap|fatal|error|invalid|denied|failed|EACCES|ENOENT/iu.test(line))
    .slice(-12);
  console.error(`[DEBUG-motrix-exit] ${state.trim()}`);
  for (const line of relevant) console.error(`[DEBUG-motrix-exit] ${line.slice(0, 1_000)}`);
}

/** @param {FailurePhase} [phase] */
async function assertFreeSpace(phase = "runtime") {
  const root = process.env.RUNNER_TEMP || tmpdir();
  const stats = await statfs(root, { bigint: true });
  if (stats.bavail * stats.bsize < BigInt(MIN_FREE_BYTES)) {
    throw new FixedServiceError(phase, "Host free space is below the Session floor.");
  }
}

/** @param {OwnedResources | undefined} resources @param {(string | undefined)[]} ownedFiles */
async function cleanup(resources, ownedFiles) {
  let failed = false;
  if (resources) {
    if (resources.service === "motrix") {
      await runCommand("docker", ["rm", "--force", resources.tokenPreparationContainer], 30_000)
        .catch(() => undefined);
    }
    if (resources.service === "openlist") {
      for (const container of [
        resources.openlistPermissionContainer,
        resources.openlistConfigurationContainer,
        resources.openlistBootstrapContainer,
      ]) await runCommand("docker", ["rm", "--force", container], 30_000).catch(() => undefined);
    }
    if (resources.upload) {
      await runCommand("docker", ["rm", "--force", `${resources.container}-rclone-upload`], 30_000).catch(() => undefined);
      await runCommand("docker", ["rm", "--force", `${resources.container}-rclone-config-check`], 30_000).catch(() => undefined);
    }
    await runCommand("docker", ["stop", "--time", resources.service === "motrix" ? "120" : "10", resources.container], 130_000).catch(() => { failed = true; });
    await runCommand("docker", ["rm", "--force", resources.container], 30_000).catch(() => { failed = true; });
    for (const volume of resources.volumes) {
      await runCommand("docker", ["volume", "rm", volume], 30_000).catch(() => { failed = true; });
    }
    const runnerTemp = await realpath(process.env.RUNNER_TEMP || tmpdir()).catch(() => undefined);
    const tempRoot = await realpath(resources.tempRoot).catch(() => undefined);
    if (!runnerTemp || !tempRoot || !within(tempRoot, runnerTemp)) failed = true;
    else await rm(tempRoot, { recursive: true }).catch(() => { failed = true; });
  }
  for (const path of ownedFiles) {
    if (!path) continue;
    await unlink(path).catch((error) => {
      if (error?.code !== "ENOENT") failed = true;
    });
  }
  return failed;
}

/** @param {unknown} error @param {FailurePhase} fallbackPhase @returns {ServiceFailure} */
function asServiceFailure(error, fallbackPhase) {
  if (error instanceof FixedServiceError) return { phase: error.phase, summary: error.summary };
  return {
    phase: fallbackPhase,
    summary: fallbackPhase === "startup" ? "Selected Service startup failed." : "Selected Service failed while Ready.",
  };
}

/** @param {Service} service */
function accessGuidance(service) {
  if (service === "chrome") {
    return "Use native Basic Auth with username `session` and the Session Credential.";
  }
  if (service === "motrix") return "Use the native Motrix login with the Motrix Operator Token.";
  return "Use the native OpenList login with username `admin` and the Session Credential.";
}

/** @param {number} milliseconds @param {AbortSignal} signal */
function abortableDelay(milliseconds, signal) {
  if (signal.aborted) return Promise.resolve();
  /** @type {Promise<void>} */
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

/** @param {string} command @param {string[]} args @param {number} [timeoutMilliseconds] @param {AbortSignal} [signal] @param {string} [input] */
function runCommand(command, args, timeoutMilliseconds = 60_000, signal, input) {
  if (signal?.aborted) return Promise.reject(new Error(`${command} cancelled`));
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env: process.env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let output = Buffer.alloc(0);
    /** @param {Buffer} chunk */
    const collect = (chunk) => {
      output = Buffer.concat([output, chunk]).subarray(-MAX_COMMAND_OUTPUT);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = timeoutMilliseconds > 0
      ? setTimeout(() => child.kill("SIGKILL"), timeoutMilliseconds)
      : undefined;
    const cancel = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      rejectPromise(error);
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (code === 0) resolvePromise(output.toString("utf8"));
      else rejectPromise(new CommandExecutionError(command, code, output.toString("utf8")));
    });
  });
}
