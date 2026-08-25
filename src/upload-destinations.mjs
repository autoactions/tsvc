import { join } from "node:path";

export const MOTRIX_DOWNLOADS_ROOT = "/downloads";

/** @param {unknown} candidate */
export function isRcloneDestination(candidate) {
  if (typeof candidate !== "string") return false;
  const separator = candidate.indexOf(":");
  const remote = candidate.slice(0, separator);
  return separator >= 1 &&
    /^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(remote) &&
    !/[\u0000-\u001f\u007f]/.test(candidate);
}

/**
 * Parse the repository-controlled JSON manifest and derive the only local
 * roots that Motrix may use. Local roots are never accepted from the file.
 *
 * @param {string} source
 * @returns {{ id: string, localRoot: string, destination: string }[]}
 */
export function parseUploadDestinations(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("invalid upload destinations");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("invalid upload destinations");
  }
  const ids = new Set();
  return value.map((entry) => {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).some((key) => key !== "id" && key !== "destination")
    ) throw new Error("invalid upload destinations");
    const record = /** @type {Record<string, unknown>} */ (entry);
    const id = record.id;
    const destination = record.destination;
    if (
      typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ||
      ids.has(id) || typeof destination !== "string" || !isRcloneDestination(destination)
    ) throw new Error("invalid upload destinations");
    ids.add(id);
    return { id, localRoot: join(MOTRIX_DOWNLOADS_ROOT, id), destination };
  });
}
