import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProxyUrl,
  decodeChunkedBody,
  isNullBodyStatus,
  normalizeRequestBody,
} from "../src/server/utils/proxy.js";

test("decodeChunkedBody 正確解碼多區塊、chunk-ext 與跨區塊 UTF-8 字元", () => {
  const utf8Part = Buffer.from("測試", "utf8"); // 6 bytes，拆成 2 + 4 bytes 測試跨區塊合併
  const raw = Buffer.concat([
    Buffer.from("5;ext=1\r\nHello\r\n", "utf8"),
    Buffer.from(`${utf8Part.subarray(0, 2).length.toString(16)}\r\n`),
    utf8Part.subarray(0, 2),
    Buffer.from("\r\n"),
    Buffer.from(`${utf8Part.subarray(2).length.toString(16).toUpperCase()}\r\n`),
    utf8Part.subarray(2),
    Buffer.from("\r\n0\r\n\r\n"),
  ]);
  const decoded = decodeChunkedBody(new Uint8Array(raw));
  assert.equal(new TextDecoder().decode(decoded), "Hello測試");
});

test("decodeChunkedBody 在截斷或非法區塊長度時拋出錯誤", () => {
  assert.throws(
    () => decodeChunkedBody(new TextEncoder().encode("5\r\nabc")),
    /截斷/,
  );
  assert.throws(
    () => decodeChunkedBody(new TextEncoder().encode("xyz\r\nabc\r\n0\r\n\r\n")),
    /無效/,
  );
});

test("isNullBodyStatus 正確辨識不可帶 body 的 HTTP 狀態碼", () => {
  for (const status of [101, 204, 205, 304]) {
    assert.equal(isNullBodyStatus(status), true);
  }
  for (const status of [200, 201, 400, 404, 500]) {
    assert.equal(isNullBodyStatus(status), false);
  }
});

test("buildProxyUrl 為 IPv6 主機自動加上方括號並安全編碼帳密", () => {
  assert.equal(
    buildProxyUrl({ protocol: "socks5", host: "2001:db8::1", port: 1080 }),
    "socks5://[2001:db8::1]:1080",
  );
  assert.equal(
    buildProxyUrl({ protocol: "http", host: "[::1]", port: 7890, username: "u@a", password: "p:w/中文" }),
    "http://u%40a:p%3Aw%2F%E4%B8%AD%E6%96%87@[::1]:7890",
  );
});

test("normalizeRequestBody 支援常見 Web Fetch body 型別", () => {
  assert.equal(normalizeRequestBody(null), null);
  assert.equal(normalizeRequestBody(undefined), null);
  assert.deepEqual(normalizeRequestBody("abc"), new Uint8Array([97, 98, 99]));
  assert.deepEqual(normalizeRequestBody(new Uint8Array([1, 2]).buffer), new Uint8Array([1, 2]));
  assert.equal(
    new TextDecoder().decode(normalizeRequestBody(new URLSearchParams({ a: "1", b: "2" }))),
    "a=1&b=2",
  );
});
