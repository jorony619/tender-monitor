// Run: node --test scripts/osce_source.test.mjs
// Fixtures mimic the fields seen on https://procurement.osce.org/tenders (title,
// Launch date, On behalf of, Deadline) in two different markup styles, so the
// parser is checked for NOT depending on specific class names.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseListing, parseDetail, parseLongDate, parseDeadline, isRelevant,
  osceToProject, fetchOsceCandidates
} from "./osce_source.mjs";

const SLUG_UZ = "printing-and-delivery-uzbek-language-textbook-osce-project-co-ordinator-uzbekistan";

// Style A: views-style cards, label and value in separate elements
const LIST_A = `
<nav><a href="/tenders">Tenders</a> <a href="/archived-tenders">Archived tenders</a>
  <a href="/tenders?f%5B0%5D=source%3AOSCE%20Secretariat">OSCE Secretariat (7)</a></nav>
<div class="views-row"><h4><a href="/tenders/supply-measuring-equipment-charging-stations-and-camera-traps-kyiv-ukraine">Supply of Measuring Equipment, Charging Stations and Camera Traps to Kyiv, Ukraine</a></h4>
  <div><span class="l">Launch date</span><span class="v">29 October 2026</span></div>
  <div><span class="l">On behalf of</span><span class="v">OSCE Secretariat</span></div>
  <div><span class="l">Deadline</span><span class="v">18 November 2026 - 17:00 , Europe/Vienna</span></div></div>
<div class="views-row"><h4><a href="/tenders/${SLUG_UZ}">Printing and Delivery of an Uzbek-Language Textbook for the OSCE Project Co-ordinator in Uzbekistan</a></h4>
  <div><span class="l">Launch date</span><span class="v">9 November 2026</span></div>
  <div><span class="l">On behalf of</span><span class="v"><a href="/taxonomy/term/42">OSCE Project Co-ordinator in Uzbekistan</a></span></div>
  <div><span class="l">Deadline</span><span class="v">23 November 2026 - 14:00 , Asia/Tashkent</span></div></div>
<div class="views-row"><h4><a href="/tenders/provision-fuel-osce-presence-albania">Provision of Fuel to the OSCE Presence in Albania</a></h4>
  <div><span class="l">Launch date</span><span class="v">11 November 2026</span></div>
  <div><span class="l">On behalf of</span><span class="v">OSCE Presence in Albania</span></div>
  <div><span class="l">Deadline</span><span class="v">23 November 2026 - 11:00 , Europe/Tirane</span></div></div>`;

// Style B: absolute URLs, an extra image link per card, "Label: value" on one line
const LIST_B = `
<article><a href="https://procurement.osce.org/tenders/printing-posters-brochures-kyrgyzstan"><img src="x.png"></a>
  <h3><a href="https://procurement.osce.org/tenders/printing-posters-brochures-kyrgyzstan">Printing of posters and brochures for the Programme Office in Bishkek</a></h3>
  <p>Launch date: 5 November 2026</p><p>On behalf of: OSCE Programme Office in Bishkek</p>
  <p>Deadline: 20 November 2026 - 12:00 , Asia/Bishkek</p></article>
<article><h3><a href="/tenders/supply-printers-toners-office">Supply of printers and toner cartridges</a></h3>
  <p>Launch date: 6 November 2026</p><p>On behalf of: OSCE Mission in Kosovo</p>
  <p>Deadline: 24 November 2026 - 12:00 , Europe/Vienna</p></article>`;

const DETAIL_UZ = `<html><head><title>RFQ/UZB/PMD/011/2026 | OSCE Procurement</title></head><body>
<nav>Home Tenders Key documents</nav>
<h1>Printing and Delivery of an Uzbek-Language Textbook for the OSCE Project Co-ordinator in Uzbekistan</h1>
<div class="f"><div class="fl">Reference Number</div><div class="fv">RFQ/UZB/PMD/011/2026</div></div>
<div class="f"><div class="fl">Procurement procedures</div><div class="fv">Request for Quotation (RFQ)</div></div>
<div class="f"><div class="fl">Launch date</div><div class="fv">09 November 2026</div></div>
<div class="f"><div class="fl">Deadline</div><div class="fv">23 November 2026 - 14:00 , Asia/Tashkent</div></div>
<div class="f"><div class="fl">Expected contract duration</div><div class="fv">One-off purchase</div></div>
<h3>Summary of Requirements</h3>
<p>The OSCE Project Co-ordinator in Uzbekistan invites qualified bidders to submit quotations for the printing and delivery of an Uzbek-language textbook in accordance with the technical specifications and requirements outlined in this RFQ.</p>
<a href="/form/direct-download-form?source_entity_id=316563">Download bidding documents</a>
<footer><ul><li>Home</li><li>Contacts</li></ul></footer></body></html>`;

test("parseListing: style A (separate label/value, nav + filter links ignored)", () => {
  const cards = parseListing(LIST_A);
  assert.equal(cards.length, 3);
  const uz = cards.find(c => c.href === `/tenders/${SLUG_UZ}`);
  assert.ok(uz);
  assert.equal(uz.title, "Printing and Delivery of an Uzbek-Language Textbook for the OSCE Project Co-ordinator in Uzbekistan");
  assert.equal(uz.launch, "2026-11-09");
  assert.equal(uz.office, "OSCE Project Co-ordinator in Uzbekistan");
  assert.match(uz.deadlineRaw, /23 November 2026/);
});

test("parseListing: style B (absolute URLs, image duplicate link, 'Label: value')", () => {
  const cards = parseListing(LIST_B);
  assert.equal(cards.length, 2);
  const p = cards.find(c => /posters/.test(c.href));
  assert.equal(p.href, "/tenders/printing-posters-brochures-kyrgyzstan");
  assert.equal(p.title, "Printing of posters and brochures for the Programme Office in Bishkek");
  assert.equal(p.launch, "2026-11-05");
  assert.equal(p.office, "OSCE Programme Office in Bishkek");
});

test("parseListing: empty / no-tender page returns []", () => {
  assert.deepEqual(parseListing("<html><body><nav><a href='/tenders'>Tenders</a></nav></body></html>"), []);
});

test("dates and Beijing-time conversion (incl. DST-free Nov, various zones)", () => {
  assert.equal(parseLongDate("9 November 2026"), "2026-11-09");
  assert.equal(parseDeadline("23 November 2026 - 14:00 , Asia/Tashkent").beijing, "2026-11-23 17:00");
  assert.equal(parseDeadline("18 November 2026 - 23:59 , Asia/Dushanbe").beijing, "2026-11-19 02:59");
  assert.equal(parseDeadline("18 November 2026 - 17:00 , Europe/Vienna").beijing, "2026-11-19 00:00");
  assert.equal(parseDeadline("23 November 2026 - 11:00 , Europe/Tirane").beijing, "2026-11-23 18:00");
  // summer time (Vienna UTC+2): 17:00 -> 15:00Z -> 23:00 Beijing
  assert.equal(parseDeadline("15 July 2026 - 17:00 , Europe/Vienna").beijing, "2026-07-15 23:00");
  // unknown tz or no time -> falls back to end of that date (never earlier than reality)
  assert.equal(parseDeadline("23 November 2026 - 14:00 , Mars/Olympus").beijing, "2026-11-23 23:59");
  assert.equal(parseDeadline("23 November 2026").beijing, "2026-11-23 23:59");
  assert.deepEqual(parseDeadline(""), { local: null, ymd: null, beijing: null });
});

test("isRelevant keeps printing/publication work, drops unrelated and equipment", () => {
  assert.ok(isRelevant("Printing and Delivery of an Uzbek-Language Textbook for the OSCE Project Co-ordinator in Uzbekistan"));
  assert.ok(isRelevant("Printing of posters and brochures for the Programme Office in Bishkek"));
  assert.ok(isRelevant("Translation and Publishing of Handbook"));
  assert.ok(!isRelevant("Supply of Measuring Equipment, Charging Stations and Camera Traps to Kyiv, Ukraine"));
  assert.ok(!isRelevant("Provision of Fuel to the OSCE Presence in Albania"));
  assert.ok(!isRelevant("Rental of Premises for the OSCE Project Co-ordinator in Uzbekistan"));
  assert.ok(!isRelevant("Supply of printers and toner cartridges"));
  assert.ok(!isRelevant("Booking of hotel accommodation")); // "booking" is not "book"
});

test("parseDetail extracts reference, procedure, duration and summary (stops at download link)", () => {
  const d = parseDetail(DETAIL_UZ);
  assert.equal(d.ref, "RFQ/UZB/PMD/011/2026");
  assert.equal(d.procedure, "Request for Quotation (RFQ)");
  assert.equal(d.duration, "One-off purchase");
  assert.match(d.summary, /^The OSCE Project Co-ordinator in Uzbekistan invites qualified bidders/);
  assert.ok(!/Download bidding documents|Contacts/.test(d.summary));
});

test("osceToProject: schema, grading and bilingual fields", () => {
  const card = parseListing(LIST_A).find(c => c.href.includes("uzbek"));
  const p = osceToProject(card, parseDetail(DETAIL_UZ), "2026-11-12");
  assert.equal(p.region, "international");
  assert.equal(p.sample, false);
  assert.equal(p.verified, true);
  assert.equal(p.projectNo, "RFQ/UZB/PMD/011/2026");
  assert.equal(p.issuer, "OSCE – Project Co-ordinator in Uzbekistan");
  assert.deepEqual(p.country, { zh: "乌兹别克斯坦", en: "Uzbekistan" });
  assert.equal(p.publishDate, "2026-11-09");
  assert.equal(p.deadlineBeijing, "2026-11-23 17:00");
  assert.equal(p.sourceUrl, `https://procurement.osce.org/tenders/${SLUG_UZ}`);
  assert.equal(p.grade, "B"); // open + textbook, but eligibility unconfirmed -> never A
  assert.equal(p.fundingSource, "OSCE");
  for (const k of ["gradeLabel", "nextAction", "status", "notes", "summary", "projectType"]) {
    assert.ok(p[k].zh && p[k].en, `${k} must be bilingual`);
  }
  // past deadline -> D
  const old = osceToProject(card, null, "2026-12-01");
  assert.equal(old.grade, "D");
  // non-textbook printing -> C
  const poster = osceToProject(parseListing(LIST_B)[0], null, "2026-11-12");
  assert.equal(poster.grade, "C");
});

function mockFetch(routes) {
  return async (url) => {
    const u = String(url).replace("https://procurement.osce.org", "");
    if (u in routes) {
      const r = routes[u];
      if (r instanceof Error) throw r;
      return { ok: r.status ? r.status < 400 : true, status: r.status || 200, text: async () => r.body ?? r };
    }
    return { ok: false, status: 404, text: async () => "nf" };
  };
}

test("fetchOsceCandidates: paginates, filters, fetches details, stops on page with nothing new", async () => {
  const calls = [];
  const f = mockFetch({
    "/tenders?page=0": LIST_A,
    "/tenders?page=1": LIST_B,
    "/tenders?page=2": LIST_B, // repeats -> no new cards -> stop
    [`/tenders/${SLUG_UZ}`]: DETAIL_UZ,
    "/tenders/printing-posters-brochures-kyrgyzstan": "<h1>x</h1>" // detail without fields still ok
  });
  const wrapped = async (u, o, t) => { calls.push(String(u)); return f(u, o, t); };
  const silent = { log() {}, warn() {} };
  const r = await fetchOsceCandidates({ fetchWithTimeout: wrapped, today: "2026-11-12", logger: silent });
  assert.equal(r.error, null);
  assert.equal(r.listed, 5);
  assert.equal(r.items.length, 2); // Uzbek textbook + posters (fuel, equipment, printers dropped)
  assert.ok(r.items.some(i => i.projectNo === "RFQ/UZB/PMD/011/2026"));
  assert.ok(calls.filter(c => c.includes("/tenders?page=")).length === 3);
});

test("fetchOsceCandidates never throws: network error / 403 / 0 rows are reported via .error", async () => {
  const silent = { log() {}, warn() {} };
  let r = await fetchOsceCandidates({ fetchWithTimeout: mockFetch({ "/tenders?page=0": new Error("boom") }), logger: silent });
  assert.deepEqual([r.items.length, r.listed], [0, 0]);
  assert.match(r.error, /listing fetch failed/);

  r = await fetchOsceCandidates({ fetchWithTimeout: mockFetch({ "/tenders?page=0": { status: 403, body: "no" } }), logger: silent });
  assert.match(r.error, /403/);

  r = await fetchOsceCandidates({ fetchWithTimeout: mockFetch({ "/tenders?page=0": "<html>layout changed</html>" }), logger: silent });
  assert.match(r.error, /parsed 0 tenders/);
});

test("fetchOsceCandidates: a failing detail page degrades to listing data, not an error", async () => {
  const silent = { log() {}, warn() {} };
  const r = await fetchOsceCandidates({
    fetchWithTimeout: mockFetch({ "/tenders?page=0": LIST_A, [`/tenders/${SLUG_UZ}`]: { status: 500, body: "x" } }),
    today: "2026-11-12", logger: silent
  });
  assert.equal(r.error, null);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].projectNo, ""); // no detail -> no ref, still usable
  assert.equal(r.items[0].deadlineBeijing, "2026-11-23 17:00");
});
