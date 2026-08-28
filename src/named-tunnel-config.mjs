export class NamedTunnelConfigError extends Error {}
export class NamedTunnelConfigNotApplied extends Error {}

/** @param {string} response @param {string} origin @returns {string | undefined} */
export function namedTunnelAddressFromConfig(response, origin) {
  let parsed;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new NamedTunnelConfigError("Named Tunnel configuration was invalid.");
  }
  if (
    !parsed || typeof parsed !== "object" ||
    !Number.isSafeInteger(parsed.version) ||
    !parsed.config || typeof parsed.config !== "object" ||
    !Array.isArray(parsed.config.ingress)
  ) {
    throw new NamedTunnelConfigError("Named Tunnel configuration was invalid.");
  }
  if (parsed.version < 0) throw new NamedTunnelConfigNotApplied();
  const originPort = new URL(origin).port;
  const candidates = [];
  for (const route of parsed.config.ingress) {
    if (!route || typeof route !== "object" || typeof route.service !== "string") {
      throw new NamedTunnelConfigError("Named Tunnel configuration was invalid.");
    }
    let service;
    try {
      service = new URL(route.service);
    } catch {
      if (new RegExp(`:${originPort}(?:\\D|$)`).test(route.service)) {
        throw new NamedTunnelConfigError("Named Tunnel route for the selected Service was malformed.");
      }
      continue;
    }
    if (service.port !== originPort) {
      if (new RegExp(`:${originPort}(?:\\D|$)`).test(route.service)) {
        throw new NamedTunnelConfigError("Named Tunnel route for the selected Service was malformed.");
      }
      continue;
    }
    if (
      service.protocol !== "http:" || !service.hostname ||
      service.username || service.password || service.pathname !== "/" || service.search || service.hash
    ) {
      throw new NamedTunnelConfigError("Named Tunnel route for the selected Service was malformed.");
    }
    const hostname = typeof route.hostname === "string" ? route.hostname : "";
    const path = route.path;
    if (
      !hostname || hostname.includes("*") ||
      (path !== undefined && path !== null && path !== "") ||
      !isExactPublicHostname(hostname)
    ) {
      throw new NamedTunnelConfigError(
        "Named Tunnel route for the selected Service must use one exact hostname without a path.",
      );
    }
    candidates.push(`https://${hostname.toLowerCase()}`);
  }
  if (candidates.length > 1) {
    throw new NamedTunnelConfigError("Named Tunnel has multiple routes for the selected Service.");
  }
  return candidates[0];
}

/** @param {string} hostname */
function isExactPublicHostname(hostname) {
  return hostname.length <= 253 && hostname.includes(".") && hostname.split(".").every(
    (label) => /^(?=.{1,63}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
  );
}
