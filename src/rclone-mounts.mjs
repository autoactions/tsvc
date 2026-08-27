const MOUNT_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*$/;

/**
 * @param {string} source
 * @returns {{ id: string, source: string, remote: string }[]}
 */
export function parseRcloneMounts(source) {
  const mounts = [];
  const ids = new Set();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("=");
    const id = line.slice(0, separator).trim();
    const remoteSource = line.slice(separator + 1).trim();
    const remoteSeparator = remoteSource.indexOf(":");
    const remote = remoteSource.slice(0, remoteSeparator);
    if (
      separator < 1 || !MOUNT_ID.test(id) || ids.has(id) ||
      remoteSeparator < 1 || !REMOTE_NAME.test(remote) ||
      /[\u0000-\u001f\u007f]/u.test(remoteSource)
    ) throw new Error("invalid rclone mounts");
    ids.add(id);
    mounts.push({ id, source: remoteSource, remote });
  }
  if (mounts.length === 0) throw new Error("invalid rclone mounts");
  return mounts;
}
