import test from "node:test";
import assert from "node:assert";
import { check } from "../api/proxy.js";

test("proxy whitelist", () => {
  assert.ok(check("https://api.rh.lighter.xyz/api/v1/orderBookDetails").url);
  assert.ok(check("https://explorer.elliot.ai/api/accounts/0xabc/logs?limit=100").url);
  assert.equal(check("https://evil.com/api/v1/x").error, "host not allowed");
  assert.equal(check("http://api.rh.lighter.xyz/api/v1/x").error, "host not allowed");
  assert.equal(check("https://api.rh.lighter.xyz.evil.com/api/v1/x").error, "host not allowed");
  assert.equal(check("https://user@api.rh.lighter.xyz/api/v1/x").error, "host not allowed");
  assert.equal(check("https://api.rh.lighter.xyz/admin").error, "path not allowed");
  assert.equal(check("https://api.rh.lighter.xyz/api/v1/livePoints/total?auth=x").error, "auth not allowed");
  assert.equal(check("not a url").error, "bad url");
});

test("proxy refuses auth params in any case", () => {
  assert.equal(check("https://api.rh.lighter.xyz/api/v1/livePoints/total?AUTH=x").error, "auth not allowed");
  assert.equal(check("https://api.rh.lighter.xyz/api/v1/livePoints/total?Authorization=x").error, "auth not allowed");
  assert.equal(check("https://api.rh.lighter.xyz/api/v1/x?au%74h=x").error, "auth not allowed");
  assert.equal(check("https://api.rh.lighter.xyz/api/../admin").error, "path not allowed");
});
