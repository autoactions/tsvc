import assert from "node:assert/strict";
import test from "node:test";

import { parseOpenListDatabase } from "../src/openlist-database.mjs";

test("SC-04 accepts only the closed OpenList database configuration", () => {
  const expected = {
    host: "mysql.internal.example",
    port: 3306,
    user: "openlist_user",
    password: "p@ss:w?rd#value",
    name: "openlist",
  };
  assert.deepEqual(parseOpenListDatabase(JSON.stringify(expected)), expected);

  for (const value of [
    "",
    "not-json",
    "[]",
    "{}",
    JSON.stringify({ ...expected, extra: true }),
    JSON.stringify({ ...expected, host: "https://mysql.example.com" }),
    JSON.stringify({ ...expected, host: "mysql_example.com" }),
    JSON.stringify({ ...expected, port: 0 }),
    JSON.stringify({ ...expected, port: "3306" }),
    JSON.stringify({ ...expected, user: "user:name" }),
    JSON.stringify({ ...expected, password: "" }),
    JSON.stringify({ ...expected, password: "line\nvalue" }),
    JSON.stringify({ ...expected, name: "openlist-db" }),
  ]) assert.throws(() => parseOpenListDatabase(value));
});
