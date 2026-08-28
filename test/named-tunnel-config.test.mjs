import assert from "node:assert/strict";
import test from "node:test";

import {
  NamedTunnelConfigError,
  NamedTunnelConfigNotApplied,
  namedTunnelAddressFromConfig,
} from "../src/named-tunnel-config.mjs";

const origin = "http://127.0.0.1:58081";
/** @param {object[]} ingress */
const config = (ingress) => JSON.stringify({ version: 7, config: { ingress } });

test("TN-01 derives the address from the unique exact hostname for the selected origin port", () => {
  assert.equal(namedTunnelAddressFromConfig(config([
    { hostname: "chrome.example.com", service: "http://localhost:58080" },
    { hostname: "Files.Example.com", service: "http://127.0.0.1:58081" },
    { hostname: "code.example.com", service: "http://localhost:58082" },
    { service: "http_status:404" },
  ]), origin), "https://files.example.com");
});

test("TN-01 returns no address only when the selected origin has no route", () => {
  assert.equal(namedTunnelAddressFromConfig(config([
    { hostname: "chrome.example.com", service: "http://localhost:58080" },
    { service: "http_status:404" },
  ]), origin), undefined);
});

test("TN-01 rejects unsafe or ambiguous routes for the selected origin", () => {
  const invalidIngress = [
    [{ hostname: "*.example.com", service: origin }],
    [{ path: "/files", service: origin }],
    [{ hostname: "files.example.com", path: "/files", service: origin }],
    [{ hostname: "files.example.com:443", service: origin }],
    [{ hostname: "files.example.com", service: "localhost:58081" }],
    [{ hostname: "files.example.com", service: `${origin}/files` }],
    [{ hostname: "files.example.com", service: { url: origin } }],
    [
      { hostname: "one.example.com", service: origin },
      { hostname: "two.example.com", service: "http://localhost:58081" },
    ],
  ];
  for (const ingress of invalidIngress) {
    assert.throws(
      () => namedTunnelAddressFromConfig(config(ingress), origin),
      NamedTunnelConfigError,
    );
  }
});

test("TN-01 rejects unreadable remote configuration and marks an initial config as not applied", () => {
  for (const response of ["not json", "{}"]) {
    assert.throws(() => namedTunnelAddressFromConfig(response, origin), NamedTunnelConfigError);
  }
  assert.throws(
    () => namedTunnelAddressFromConfig(config([]).replace('"version":7', '"version":-1'), origin),
    NamedTunnelConfigNotApplied,
  );
});
