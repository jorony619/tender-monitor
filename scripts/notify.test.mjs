import test from "node:test";
import assert from "node:assert/strict";
import { pickChannel, buildMessage, sendWechat } from "./notify.mjs";

const items = [{ grade: "B", projectName: "Printing of textbooks", issuer: "UNICEF", country: { zh: "乌兹别克斯坦" }, deadlineBeijing: "2026-11-23 20:00", sourceUrl: "https://x/1" }];
const quiet = { log() {}, warn() {} };

test("channel priority", () => {
  assert.equal(pickChannel({}), null);
  assert.equal(pickChannel({ WECOM_WEBHOOK: "u" }), "wecom");
  assert.equal(pickChannel({ PUSHPLUS_TOKEN: "t", WECOM_WEBHOOK: "u" }), "pushplus");
  assert.equal(pickChannel({ SERVERCHAN_KEY: "k", PUSHPLUS_TOKEN: "t" }), "serverchan");
});
test("message content", () => {
  const m = buildMessage(items, { dashboardUrl: "https://d/" });
  assert.match(m.title, /新增 1 个/);
  assert.match(m.body, /\[B\] Printing of textbooks/);
  assert.match(m.body, /看板：https:\/\/d\//);
});
test("no channel -> skipped, no fetch", async () => {
  let called = false;
  const r = await sendWechat({ fetchWithTimeout: async () => { called = true; }, items, env: {}, logger: quiet });
  assert.equal(r.sent, false); assert.equal(called, false);
});
test("each channel posts to its endpoint", async () => {
  for (const [env, urlPart, okBody] of [
    [{ SERVERCHAN_KEY: "SCT1" }, "sctapi.ftqq.com/SCT1.send", '{"code":0}'],
    [{ PUSHPLUS_TOKEN: "tok" }, "pushplus.plus/send", '{"code":200}'],
    [{ WECOM_WEBHOOK: "https://qyapi.weixin.qq.com/hook?key=k" }, "qyapi.weixin.qq.com", '{"errcode":0}']
  ]) {
    let seen;
    const f = async (url, o) => { seen = { url, o }; return { ok: true, status: 200, text: async () => okBody }; };
    const r = await sendWechat({ fetchWithTimeout: f, items, env, logger: quiet });
    assert.equal(r.sent, true); assert.ok(seen.url.includes(urlPart));
  }
});
test("API-level and network errors never throw", async () => {
  let r = await sendWechat({ fetchWithTimeout: async () => ({ ok: true, status: 200, text: async () => '{"code":40001,"message":"bad"}' }), items, env: { SERVERCHAN_KEY: "SECRETKEY" }, logger: quiet });
  assert.equal(r.sent, false); assert.ok(r.error);
  r = await sendWechat({ fetchWithTimeout: async () => { throw new Error("boom SECRETKEY"); }, items, env: { SERVERCHAN_KEY: "SECRETKEY" }, logger: quiet });
  assert.equal(r.sent, false); assert.ok(!r.error.includes("SECRETKEY"));
});
