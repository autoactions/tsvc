/**
 * @typedef {{ host: string, port: number, user: string, password: string, name: string }} OpenListDatabase
 */

/** @param {unknown} value @returns {OpenListDatabase} */
export function parseOpenListDatabaseValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (Object.keys(candidate).sort().join(",") !== "host,name,password,port,user") {
    throw new Error("invalid");
  }
  const { host, port, user, password, name } = candidate;
  if (
    typeof host !== "string" || !validDnsName(host) ||
    !Number.isInteger(port) || /** @type {number} */ (port) < 1 || /** @type {number} */ (port) > 65_535 ||
    typeof user !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(user) ||
    typeof password !== "string" || password.length === 0 || password.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(password) ||
    typeof name !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(name)
  ) {
    throw new Error("invalid");
  }
  return { host, port: /** @type {number} */ (port), user, password, name };
}

/** @param {string} source @returns {OpenListDatabase} */
export function parseOpenListDatabase(source) {
  return parseOpenListDatabaseValue(JSON.parse(source));
}

/** @param {string} value */
function validDnsName(value) {
  if (value.length < 1 || value.length > 253 || value.endsWith(".")) return false;
  return value.split(".").every((label) =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)
  );
}
