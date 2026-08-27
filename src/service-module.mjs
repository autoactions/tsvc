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
import { parseDatabase } from "./database.mjs";

const ORIGIN_HOST = "127.0.0.1";
const ORIGIN_PORTS = { chrome: 58080, openlist: 58082, "code-server": 58084 };
const MIN_FREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_COMMAND_OUTPUT = 64 * 1024;
const MAX_JSON_RESPONSE = 1024 * 1024;

const CHROME_IMAGE =
  "lscr.io/linuxserver/chrome@sha256:49a019a04b8d38422609d3c586636293417f61886704d516b7d5233cb4bd0b12";
const CHROME_USERNAME = "admin";
const OPENLIST_IMAGE =
  "openlistteam/openlist@sha256:b4de1e8e07de352a57e8f9eefbe5525c4a6eeef0ae4c74c2a1e68cb71d185fdb";
const OPENLIST_USERNAME = "admin";
const CODE_SERVER_IMAGE =
  "lscr.io/linuxserver/code-server@sha256:212d588e21815316d6525abe8d14bb0114fc2cf0499f08e9e34a1b514b1055b9";
const RCLONE_IMAGE =
  "rclone/rclone@sha256:b06aed988cf5967de7c25be5925240983981c757f4ed1ac9d2fa659d51d60548";

/** @typedef {"chrome" | "openlist" | "code-server"} Service */
/** @typedef {"startup" | "runtime" | "cleanup"} FailurePhase */
/** @typedef {{ phase: FailurePhase, summary: string }} ServiceFailure */
/** @typedef {{ accessGuidance: string, username?: string }} ServiceReady */
/** @typedef {{ status: "success" } | ServiceFailure} ServiceResult */
/**
 * @typedef {{
 *   service: Service,
 *   sessionAddress: string,
 *   credentialFile: string,
 *   cancellation: AbortSignal,
 *   rclone?: {
 *     configFile: string,
 *     mounts: { id: string, source: string, remote: string }[],
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
  try {
    validateOptions(options);
    const locations = await validateTemporaryLocations(
      options.credentialFile,
      options.rclone?.configFile,
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
      options.rclone && locations.rcloneConfigFile
        ? { configFile: locations.rcloneConfigFile, mounts: options.rclone.mounts }
        : undefined,
      database,
    );
    await runCommand("docker", ["pull", resources.image], 10 * 60_000, options.cancellation);
    console.log("Startup stage complete: Service image.");
    if (resources.rclone) {
      await runCommand("docker", ["pull", RCLONE_IMAGE], 10 * 60_000, options.cancellation);
      await extractRclone(resources, options.cancellation);
      await validateRcloneConfiguration(resources, options.cancellation);
      await startRcloneMounts(resources, options.cancellation);
      console.log("Startup stage complete: Rclone mounts.");
    }
    await assertFreeSpace("startup");
    if (options.service === "openlist") {
      await prepareOpenList(resources, options.sessionAddress, options.cancellation);
      console.log("Startup stage complete: OpenList database bootstrap.");
    }
    await startAdapter(resources, options.cancellation);
    console.log("Startup stage complete: Service container.");
    const container = resources.container;
    const containerExit = waitForContainerExit(container);
    await Promise.race([
      waitForReadiness(resources, credential, options.sessionAddress, options.cancellation),
      containerExit.then(async () => {
        if (options.cancellation.aborted) return new Promise(() => {});
        throw new FixedServiceError("startup", "Selected Service exited during startup.");
      }),
    ]);
    becameReady = true;
    const username = operatorUsername(options.service);
    ready.resolve({
      accessGuidance: accessGuidance(options.service),
      ...(username ? { username } : {}),
    });
    await Promise.race([
      supervise(resources, credential, options.sessionAddress, options.cancellation),
      containerExit.then(() => {
        if (options.cancellation.aborted) return new Promise(() => {});
        throw new FixedServiceError("runtime", "Selected Service exited.");
      }),
    ]);
  } catch (error) {
    failure = asServiceFailure(error, becameReady ? "runtime" : "startup");
    if (!becameReady) ready.reject(failure);
  } finally {
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
  if (options.service !== "chrome" && options.service !== "openlist" && options.service !== "code-server") {
    throw new FixedServiceError("startup", "Selected Service is invalid.");
  }
  if (!isAbsolute(options.credentialFile)) {
    throw new FixedServiceError("startup", "Selected Service credential file is invalid.");
  }
  if (
    options.rclone && (
      !isAbsolute(options.rclone.configFile) ||
      !validRcloneMounts(options.rclone.mounts)
    )
  ) {
    throw new FixedServiceError("startup", "Rclone configuration is invalid.");
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

/** @param {unknown} mounts */
function validRcloneMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length === 0) return false;
  const ids = new Set();
  return mounts.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = /** @type {Record<string, unknown>} */ (entry);
    if (
      typeof value.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.id) ||
      ids.has(value.id) || typeof value.source !== "string" || typeof value.remote !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(value.remote) ||
      !value.source.startsWith(`${value.remote}:`) || /[\u0000-\u001f\u007f]/u.test(value.source)
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
  const valid = service === "chrome" || service === "code-server"
    ? isSessionCredential(value)
    : isSessionCredential(value) && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
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
   * @param {{ configFile: string, mounts: { id: string, source: string, remote: string }[] } | undefined} rclone
   * @param {{ connection: { host: string, port: number, user: string, password: string }, caFile: string } | undefined} database
   */
  constructor(service, credentialFile, tempRoot, rclone, database) {
    this.service = service;
    this.credentialFile = credentialFile;
    this.tempRoot = tempRoot;
    this.suffix = `${process.pid}-${randomBytes(6).toString("hex")}`;
    this.container = `temporary-session-${service}-${this.suffix}`;
    this.rcloneExtractionContainer = `${this.container}-rclone-extraction`;
    this.openlistPermissionContainer = `${this.container}-openlist-permissions`;
    this.openlistConfigurationContainer = `${this.container}-openlist-configuration`;
    this.openlistBootstrapContainer = `${this.container}-openlist-bootstrap`;
    this.image = service === "chrome"
      ? CHROME_IMAGE
      : service === "code-server"
        ? CODE_SERVER_IMAGE
        : OPENLIST_IMAGE;
    const processes = /** @type {{ child: import("node:child_process").ChildProcess, mountPath: string }[]} */ ([]);
    this.rclone = rclone
      ? {
          ...rclone,
          configDirectory: join(tempRoot, "rclone-config"),
          privateConfigFile: join(tempRoot, "rclone-config", "rclone.conf"),
          binary: join(tempRoot, "rclone"),
          mountRoot: join(tempRoot, "rclone-mounts"),
          cacheRoot: join(tempRoot, "rclone-cache"),
          processes,
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
      : service === "code-server"
        ? [`temporary-session-code-server-config-${this.suffix}`]
        : [`temporary-session-openlist-data-${this.suffix}`];
  }
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
    temp_dir: "/opt/openlist/data/temp",
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
    'OPENLIST_ADMIN_PASSWORD="$(cat /run/secrets/session-credential)" || exit 64; [ -n "$OPENLIST_ADMIN_PASSWORD" ] || exit 65; export OPENLIST_ADMIN_PASSWORD; ./openlist admin >/dev/null 2>&1 && exec ./openlist admin set "$OPENLIST_ADMIN_PASSWORD" >/dev/null 2>&1',
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
 * @param {{ configFile: string, mounts: { id: string, source: string, remote: string }[] } | undefined} rclone
 * @param {{ connection: { host: string, port: number, user: string, password: string }, caFile: string } | undefined} database
 */
async function createOwnedResources(service, credentialFile, runnerTemp, cancellation, rclone, database) {
  const tempRoot = await mkdtemp(join(runnerTemp, "temporary-session-"));
  await chmod(tempRoot, 0o700);
  const resources = new OwnedResources(service, credentialFile, tempRoot, rclone, database);
  /** @type {string[]} */
  const createdVolumes = [];
  try {
    if (resources.rclone) {
      await mkdir(resources.rclone.configDirectory, { mode: 0o700 });
      await mkdir(resources.rclone.mountRoot, { mode: 0o700 });
      await mkdir(resources.rclone.cacheRoot, { mode: 0o700 });
      await copyFile(resources.rclone.configFile, resources.rclone.privateConfigFile);
      await chmod(resources.rclone.privateConfigFile, 0o600);
      for (const mount of resources.rclone.mounts) {
        await mkdir(join(resources.rclone.mountRoot, mount.id), { mode: 0o700 });
      }
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

/** @param {OwnedResources} resources @param {AbortSignal} cancellation */
async function validateRcloneConfiguration(resources, cancellation) {
  if (!resources.rclone) return;
  const output = await runCommand(resources.rclone.binary, [
    "--config", resources.rclone.privateConfigFile,
    "listremotes",
  ], 60_000, cancellation).catch(() => {
    throw new FixedServiceError("startup", "Rclone configuration validation failed.");
  });
  const configured = new Set(output.split(/\r?\n/));
  const remotes = resources.rclone.mounts.map(({ remote }) => remote);
  if (remotes.some((remote) => !configured.has(`${remote}:`))) {
    throw new FixedServiceError("startup", "Rclone mount remote is not configured.");
  }
}

/** @param {OwnedResources} resources @param {AbortSignal} cancellation */
async function extractRclone(resources, cancellation) {
  if (!resources.rclone) return;
  await runCommand("docker", [
    "create", "--name", resources.rcloneExtractionContainer,
    "--entrypoint", "/bin/true", RCLONE_IMAGE,
  ], 60_000, cancellation).catch(() => {
    throw new FixedServiceError("startup", "Rclone executable setup failed.");
  });
  try {
    await runCommand("docker", [
      "cp", `${resources.rcloneExtractionContainer}:/usr/local/bin/rclone`, resources.rclone.binary,
    ], 60_000, cancellation);
    await chmod(resources.rclone.binary, 0o700);
  } catch {
    throw new FixedServiceError("startup", "Rclone executable setup failed.");
  } finally {
    await runCommand("docker", ["rm", "--force", resources.rcloneExtractionContainer], 30_000)
      .catch(() => undefined);
  }
}

/** @param {OwnedResources} resources @param {AbortSignal} cancellation */
async function startRcloneMounts(resources, cancellation) {
  if (!resources.rclone) return;
  const fuse = await lstat("/dev/fuse").catch(() => undefined);
  if (!fuse?.isCharacterDevice()) throw new FixedServiceError("startup", "FUSE is unavailable.");
  await runCommand("fusermount3", ["--version"], 5_000).catch(() => {
    throw new FixedServiceError("startup", "FUSE is unavailable.");
  });
  for (const mount of resources.rclone.mounts) {
    const mountPath = join(resources.rclone.mountRoot, mount.id);
    const child = spawn(resources.rclone.binary, [
      "--config", resources.rclone.privateConfigFile,
      "mount", mount.source, mountPath,
      "--allow-other",
      "--vfs-cache-mode", "writes",
      "--cache-dir", join(resources.rclone.cacheRoot, mount.id),
      "--log-level", "ERROR",
    ], { env: process.env, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostics = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-4_096);
    });
    resources.rclone.processes.push({ child, mountPath });
    const exited = new Promise((resolvePromise) => {
      child.once("error", resolvePromise);
      child.once("close", resolvePromise);
    });
    const deadline = Date.now() + 30_000;
    while (!cancellation.aborted && Date.now() < deadline) {
      const ready = await runCommand("mountpoint", ["--quiet", mountPath], 5_000).then(() => true, () => false);
      if (ready) break;
      const stopped = await Promise.race([exited.then(() => true), abortableDelay(250, cancellation).then(() => false)]);
      if (stopped) throw new FixedServiceError("startup", "Rclone mount failed.");
    }
    const ready = await runCommand("mountpoint", ["--quiet", mountPath], 5_000).then(() => true, () => false);
    if (!ready) {
      if (diagnostics) console.error("Rclone mount did not become ready.");
      throw new FixedServiceError("startup", "Rclone mount was not ready.");
    }
  }
}

/** @param {OwnedResources} resources @param {AbortSignal} cancellation */
async function startAdapter(resources, cancellation) {
  const args = resources.service === "chrome"
    ? chromeDockerArgs(resources)
    : resources.service === "code-server"
      ? codeServerDockerArgs(resources)
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
    ...rcloneDockerMountArgs(resources),
  ];
}

/** @param {OwnedResources} resources */
function rcloneDockerMountArgs(resources) {
  const rclone = resources.rclone;
  if (!rclone) return [];
  return rclone.mounts.flatMap(({ id }) => [
    "--mount", `type=bind,source=${join(rclone.mountRoot, id)},target=/mnt/rclone/${id}`,
  ]);
}

/** @param {Service} service */
function containerPort(service) {
  if (service === "chrome") return 3000;
  if (service === "code-server") return 8443;
  return 5244;
}

/** @param {OwnedResources} resources */
function chromeDockerArgs(resources) {
  return [
    ...commonDockerArgs(resources),
    "--shm-size", "1g",
    "--env", "START_DOCKER=false",
    "--env", `CUSTOM_USER=${CHROME_USERNAME}`,
    "--env", "FILE__PASSWORD=/run/secrets/session-credential",
    "--mount", `type=volume,source=${resources.volumes[0]},target=/config`,
    "--mount", `type=bind,source=${resources.credentialFile},target=/run/secrets/session-credential,readonly`,
    resources.image,
  ];
}

/** @param {OwnedResources} resources */
function codeServerDockerArgs(resources) {
  return [
    ...commonDockerArgs(resources),
    "--env", "FILE__PASSWORD=/run/secrets/session-credential",
    "--mount", `type=volume,source=${resources.volumes[0]},target=/config`,
    "--mount", `type=bind,source=${resources.credentialFile},target=/run/secrets/session-credential,readonly`,
    resources.image,
  ];
}

/** @param {OwnedResources} resources */
function openlistDockerArgs(resources) {
  const [stateVolume] = resources.volumes;
  if (!resources.database || !stateVolume) throw new Error("missing OpenList configuration");
  return [
    ...commonDockerArgs(resources),
    "--user", "1001:1001",
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
  let openlistFailure = "local";
  let localLoginComplete = false;
  while (!cancellation.aborted) {
    if (resources.rclone?.processes.some(({ child }) => childFinished(child))) {
      throw new FixedServiceError("startup", "Rclone mount exited during startup.");
    }
    if (!(await containerRunning(resources.container, cancellation))) {
      if (cancellation.aborted) break;
      throw new FixedServiceError("startup", "Selected Service exited during startup.");
    }
    if (resources.service === "openlist") {
      try {
        await openlistLocalLogin(credential);
        if (!localLoginComplete) {
          console.log("Startup stage complete: Local OpenList admin login.");
          localLoginComplete = true;
        }
      } catch {
        openlistFailure = "local";
        await abortableDelay(1_000, cancellation);
        continue;
      }
      try {
        await openlistOfflineDownloadTools();
      } catch {
        openlistFailure = "offline-tools";
        await abortableDelay(1_000, cancellation);
        continue;
      }
      try {
        await httpStatus(`${sessionAddress}/`, {});
        console.log("Startup stage complete: Public access.");
        return;
      } catch {
        openlistFailure = "public";
        await abortableDelay(1_000, cancellation);
      }
      continue;
    }
    try {
      await requiredHealth(resources.service, credential, sessionAddress);
      return;
    } catch {
      await abortableDelay(1_000, cancellation);
    }
  }
  if (resources.service === "openlist") {
    throw new FixedServiceError(
      "startup",
      openlistFailure === "local"
        ? "Local OpenList login was not ready."
        : openlistFailure === "offline-tools"
          ? "OpenList offline download tools were not ready."
          : "Public access was not ready.",
    );
  }
  throw new FixedServiceError("startup", "Session startup was cancelled.");
}

/**
 * @param {OwnedResources} resources
 * @param {string} credential
 * @param {string} sessionAddress
 * @param {AbortSignal} cancellation
 */
async function supervise(resources, credential, sessionAddress, cancellation) {
  let unhealthySince;
  while (!cancellation.aborted) {
    if (!(await containerRunning(resources.container, cancellation))) {
      if (cancellation.aborted) break;
      throw new FixedServiceError("runtime", "Selected Service exited.");
    }
    if (resources.rclone?.processes.some(({ child }) => childFinished(child))) {
      throw new FixedServiceError("runtime", "Rclone mount exited.");
    }
    await assertFreeSpace();
    try {
      await requiredHealth(resources.service, credential, sessionAddress);
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

/** @param {Service} service @param {string} credential @param {string} sessionAddress */
async function requiredHealth(service, credential, sessionAddress) {
  const localBase = `http://${ORIGIN_HOST}:${originPort(service)}`;
  if (service === "chrome") {
    const authorization = `Basic ${Buffer.from(`${CHROME_USERNAME}:${credential}`).toString("base64")}`;
    await Promise.all([
      httpStatus(`${localBase}/`, { authorization }),
      httpStatus(`${sessionAddress}/`, { authorization }),
      websocketUpgrade(`${sessionAddress}/websocket`, { authorization }),
    ]);
    return;
  }
  if (service === "code-server") {
    await Promise.all([
      httpStatus(`${localBase}/`, {}),
      httpStatus(`${sessionAddress}/`, {}),
    ]);
    return;
  }
  if (service === "openlist") {
    await openlistLocalLogin(credential);
    await openlistOfflineDownloadTools();
    await httpStatus(`${sessionAddress}/`, {});
    return;
  }
  throw new Error("invalid service");
}

/** @param {string} credential */
async function openlistLocalLogin(credential) {
  const login = await httpJson(
    `http://${ORIGIN_HOST}:${originPort("openlist")}/api/auth/login`,
    {},
    "POST",
    JSON.stringify({ username: OPENLIST_USERNAME, password: credential }),
  );
  if (
    !login || typeof login !== "object" ||
    /** @type {Record<string, unknown>} */ (login).code !== 200 ||
    !/** @type {{ data?: { token?: unknown } }} */ (login).data ||
    typeof /** @type {{ data: { token?: unknown } }} */ (login).data.token !== "string"
  ) throw new Error("unhealthy");
}

async function openlistOfflineDownloadTools() {
  const response = await httpJson(
    `http://${ORIGIN_HOST}:${originPort("openlist")}/api/public/offline_download_tools`,
    {},
  );
  const tools = response && typeof response === "object"
    ? /** @type {{ code?: unknown, data?: unknown }} */ (response)
    : undefined;
  if (
    tools?.code !== 200 || !Array.isArray(tools.data) ||
    !tools.data.includes("aria2") || !tools.data.includes("SimpleHttp")
  ) throw new Error("unhealthy");
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

/** @param {string} url @param {Record<string, string>} headers @param {string} [method] @param {string} [body] @param {AbortSignal} [signal] */
function httpJson(url, headers, method = "GET", body, signal) {
  /** @type {Promise<unknown>} */
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(parsed, {
      headers: body === undefined ? headers : {
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
        if (output.length > MAX_JSON_RESPONSE) response.destroy(new Error("response too large"));
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
    if (body !== undefined) request.write(body);
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

/** @param {import("node:child_process").ChildProcess} child @param {number} timeout */
function waitForChildExit(child, timeout) {
  if (childFinished(child)) return Promise.resolve();
  return /** @type {Promise<void>} */ (new Promise((resolvePromise) => {
    const finish = () => {
      clearTimeout(timer);
      child.removeListener("close", finish);
      resolvePromise();
    };
    const timer = setTimeout(finish, timeout);
    child.once("close", finish);
  }));
}

/** @param {import("node:child_process").ChildProcess} child */
function childFinished(child) {
  return child.exitCode !== null || child.signalCode !== null;
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
    if (resources.service === "openlist") {
      for (const container of [
        resources.openlistPermissionContainer,
        resources.openlistConfigurationContainer,
        resources.openlistBootstrapContainer,
      ]) await runCommand("docker", ["rm", "--force", container], 30_000).catch(() => undefined);
    }
    await runCommand("docker", ["rm", "--force", resources.rcloneExtractionContainer], 30_000).catch(() => undefined);
    await runCommand("docker", ["stop", "--time", "10", resources.container], 30_000).catch(() => { failed = true; });
    await runCommand("docker", ["rm", "--force", resources.container], 30_000).catch(() => { failed = true; });
    if (resources.rclone) {
      for (const { child, mountPath } of [...resources.rclone.processes].reverse()) {
        await runCommand("fusermount3", ["-u", mountPath], 30_000).catch(() => { failed = true; });
        if (!childFinished(child)) child.kill("SIGTERM");
        await waitForChildExit(child, 5_000);
        if (!childFinished(child)) {
          child.kill("SIGKILL");
          failed = true;
        }
      }
    }
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
    return `Use native Basic Auth with username \`${CHROME_USERNAME}\` and the Session Credential.`;
  }
  if (service === "code-server") {
    return "Use the native code-server login with the Session Credential as the password.";
  }
  return `Use the native OpenList login with username \`${OPENLIST_USERNAME}\` and the Session Credential.`;
}

/** @param {Service} service @returns {string | undefined} */
function operatorUsername(service) {
  if (service === "chrome") return CHROME_USERNAME;
  if (service === "openlist") return OPENLIST_USERNAME;
  return undefined;
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
