const dns = require("node:dns");
const originalLookup = dns.lookup;

dns.lookup = function lookup(hostname, options, callback) {
  if (!String(hostname).endsWith(".trycloudflare.com")) {
    return originalLookup.call(dns, hostname, options, callback);
  }
  if (typeof options === "function") {
    return options(null, "127.0.0.1", 4);
  }
  if (options?.all) {
    return callback(null, [{ address: "127.0.0.1", family: 4 }]);
  }
  return callback(null, "127.0.0.1", 4);
};
