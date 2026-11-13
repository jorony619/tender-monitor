import test from "node:test";
import assert from "node:assert/strict";
import { parseUngmDate, parseUngmListing, ungmToProject, fetchUngmCandidates } from "./ungm_source.mjs";

const ROW = (id, title, dl, pub, agency, type, ref, country) => `
<div class="tableRow dataRow notice-table" data-noticeid="${id}">
  <div class="tableCell resultTitle"><a href="/Public/Notice/${id}" class="ungm-title ungm-title--small"><span>${title}</span></a></div>
  <div class="tableCell">${dl}</div><div class="tableCell">${pub}</div>
  <div class="tableCell"><span>${agency}</span></div><div class="tableCell">${type}</div>
  <div class="tableCell">${ref}</div><div class="tableCell">${country}</div>
</div>`;
const PAGE = ROW(1001, "Printing and delivery of primary school textbooks", "23-Nov-2026 17:00 (GMT 5.00)", "05-Nov-2026 09:12 (GMT -5.00)", "UNICEF", "Request for quotation", "LRFQ-2026-9001234", "Uzbekistan")
  + ROW(1002, "Supply of laser printers and toner cartridges", "20-Nov-2026", "04-Nov-2026", "UNDP", "Invitation to bid", "ITB-77", "Kenya")
  + ROW(1003, "Printing of workbooks", "01-Oct-2026", "01-Sep-2026", "UNESCO", "Request for proposal", "RFP-5", "Nepal")
  + ROW(1004, "Printing of books - contract award", "01-Dec-2026", "01-Nov-2026", "WFP", "Contract award notice", "CA-1", "Chad");

test("date parse with GMT offset", () => {
  const d = parseUngmDate("23-Nov-2026 17:00 (GMT 5.00)");
  assert.equal(d.ymd, "2026-11-23");
  assert.equal(new Date(d.utcMs).toISOString(), "2026-11-23T12:00:00.000Z");
  assert.equal(parseUngmDate("garbage"), null);
});

test("listing parse", () => {
  const rows = parseUngmListing(PAGE);
  assert.equal(rows.length, 4);
  const r = rows[0];
  assert.equal(r.id, "1001");
  assert.equal(r.title, "Printing and delivery of primary school textbooks");
  assert.equal(r.agency, "UNICEF");
  assert.equal(r.noticeType, "Request for quotation");
  assert.equal(r.reference, "LRFQ-2026-9001234");
  assert.equal(r.country, "Uzbekistan");
  assert.equal(r.deadline.ymd, "2026-11-23");
  assert.equal(r.published.ymd, "2026-11-05");
});

test("listing falls back to links without data-noticeid", () => {
  const rows = parseUngmListing(`<div><a href="/Public/Notice/55">Printing of textbooks</a> 10-Dec-2026 01-Dec-2026</div>`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "55");
});

test("project grading and Beijing time", () => {
  const rows = parseUngmListing(PAGE);
  const p = ungmToProject(rows[0], "2026-11-13");
  assert.equal(p.grade, "B");
  assert.equal(p.deadlineBeijing, "2026-11-23 20:00");
  assert.equal(p.sourceUrl, "https://www.ungm.org/Public/Notice/1001");
  assert.equal(ungmToProject(rows[2], "2026-11-13").grade, "D");
});

function mockFetch(handler) {
  return async (url, opts) => handler(url, opts);
}
const ok = (body) => ({ ok: true, status: 200, headers: { getSetCookie: () => ["a=b; path=/"] }, text: async () => body });

test("end to end: filters printers & awards, dedups", async () => {
  const f = mockFetch((url) => url.endsWith("/Public/Notice") ? ok("<html></html>") : ok(PAGE));
  const r = await fetchUngmCandidates({ fetchWithTimeout: f, today: "2026-11-13", keywords: ["textbook", "workbook"], logger: { log() {}, warn() {} } });
  assert.equal(r.error, null);
  assert.equal(r.listed, 4);
  assert.deepEqual(r.items.map(i => i.projectNo), ["LRFQ-2026-9001234", "RFP-5"]);
});

test("failure paths never throw and set error", async () => {
  const log = { log() {}, warn() {} };
  let r = await fetchUngmCandidates({ fetchWithTimeout: async () => { throw new Error("blocked"); }, logger: log });
  assert.ok(r.error && r.items.length === 0);
  r = await fetchUngmCandidates({ fetchWithTimeout: mockFetch((u) => u.endsWith("/Public/Notice") ? ok("") : ok("<html>nothing</html>")), keywords: ["x"], logger: log });
  assert.ok(r.error && /0 notices/.test(r.error));
  r = await fetchUngmCandidates({ fetchWithTimeout: mockFetch((u) => u.endsWith("/Public/Notice") ? ok("") : { ok: false, status: 403, headers: {}, text: async () => "" }), keywords: ["x"], logger: log });
  assert.ok(r.error && /403/.test(r.error));
});
