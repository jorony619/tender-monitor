#!/usr/bin/env node
/**
 * update_tenders.mjs — 博查(Bocha) 一体化版：搜索 + 推理全部走博查账户
 *
 * 两步走：
 *   1. 调用博查 Web Search API（真实结构化搜索结果，含真链接），
 *      对多个关键词分别搜索 UNGM / UNICEF / World Bank / ADB 等平台上的
 *      教材/作业册/教师指南印刷招标
 *   2. 把搜到的原始结果（连同已有的 data.json）一起交给博查 Model API
 *      （DeepSeek V4，OpenAI兼容接口），让它只从"确实搜到的真实链接"里
 *      提炼出结构化项目，绝不编造项目或链接
 *
 * 两步都走同一个博查账户余额，不用再单独管理智谱那边的额度/过期时间。
 *
 * 环境变量：
 *   BOCHA_API_KEY   必填，博查AI开放平台的 API Key（搜索 + 推理都用这一个）
 *   BOCHA_MODEL     可选，默认 deepseek-v4-flash（比 deepseek-v4-pro 便宜很多，够用）
 *
 * 手动运行：
 *   BOCHA_API_KEY=xxxx node scripts/update_tenders.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");

const BOCHA_API_KEY = process.env.BOCHA_API_KEY;
if (!BOCHA_API_KEY) {
  console.error("Missing BOCHA_API_KEY environment variable.");
  process.exit(1);
}

const MODEL = process.env.BOCHA_MODEL || "deepseek-v4-flash";
const BOCHA_SEARCH_BASE_URL = "https://api.bochaai.com/v1";
const BOCHA_MODEL_BASE_URL = "https://api.bocha.cn/v1"; // Model API 走这个域名，跟 Web Search 的域名不一样

// Only look at pages published in the last month. With "noLimit" the engine
// returned mostly closed 2024-2025 notices and award announcements, so the
// model had nothing open to pick from. Override with the SEARCH_FRESHNESS env
// var (oneDay | oneWeek | oneMonth | oneYear | noLimit) if needed.
const SEARCH_FRESHNESS = process.env.SEARCH_FRESHNESS || "oneMonth";

const INTL_QUERIES = [
  "UNGM tender printing textbooks workbooks",
  "UNICEF supply printing workbooks teacher guide tender",
  "World Bank procurement notice printing textbooks",
  "ADB invitation for bids printing textbooks learning materials",
  "UNESCO UNHCR UNRWA printing textbooks tender",
  "GPE ECW education printing materials tender",
  "dgMarket Devex printing textbooks tender",
  "TED europa printing textbooks tender",
  "site:bidsinfo.com printing textbooks tender"
];

const DOMESTIC_QUERIES = [
  "教材印刷 公开招标 招标公告 预算金额 万元 site:gov.cn",
  "教辅资料印刷服务 招标公告 预算金额 万元 site:gov.cn",
  "学校 教材 教辅 印刷 采购公告 预算金额 万元 site:gov.cn"
];

const SEARCH_QUERIES = [...INTL_QUERIES, ...DOMESTIC_QUERIES];

// Generic document-sharing / content-farm sites that frequently host unrelated,
// re-uploaded PDFs (procurement guides, textbooks, etc.) with no connection to a
// live tender. Results from these domains are dropped before they ever reach the model.
//
// Also includes general news-portal / self-media (自媒体) sites: these frequently
// republish or rewrite real government procurement notices into clickbait articles
// (e.g. titles like "XX采购：你绝对不能错过的机会！") that can embellish, mix up,
// or mis-date the underlying notice. Even when the underlying fact is real, these
// are not primary sources and should not be treated as verified.
const BLOCKED_DOMAINS = [
  "book118.com", "max.book118.com", "docin.com", "wenku.baidu.com",
  "doc88.com", "doc.mbalib.com", "docs.qq.com", "coggle.it",
  "renrendoc.com", "zhuanlan.zhihu.com", "jz.docin.com", "taodocs.com",
  "docerpro.com", "mianfeiwendang.com", "chinaacc.com", "ppt.docin.com",
  "sohu.com", "sina.com.cn", "sina.com", "toutiao.com", "baijiahao.baidu.com",
  "163.com", "ifeng.com", "news.qq.com", "workercn.cn", "baidu.com",
  "so.com", "kuaibao.qq.com", "xigua.com", "weibo.com", "douyin.com"
];

// Code-level safety net for the DOMESTIC SCOPE RULE in the prompt — don't
// rely solely on the LLM following instructions. Catches raw paper/consumable
// purchases and generic ad-production listings that aren't actually a
// textbook/workbook/teacher's-guide printing SERVICE.
const OFF_SCOPE_DOMESTIC_NAME = /用纸采购|复印纸.{0,6}(采购|订购)|纸张采购|耗材采购|广告制作|宣传品制作/;
function isOffScopeDomestic(item) {
  // Check by content pattern regardless of how "region" got labeled — a raw
  // paper/consumables/ad-production listing is out of scope either way.
  return OFF_SCOPE_DOMESTIC_NAME.test(String(item.projectName || ""));
}

// Code-level safety net for the TENDER-vs-RESULT RULE in the prompt — same
// "don't trust the LLM alone" approach. Catches award/result notices (bidding
// already closed, winner already announced) in either language, regardless
// of region, so they never get added even as a D-graded historical entry.
const RESULT_NOTICE_PATTERN = /成交公告|成交公示|成交信息|成交供应商|成交结果|议价成交|中标公告|中标结果|中标候选人|结果公告|结果公示|合同公告|废标公告|流标公告|竞价成交|contract award|award notice|results? notice|winning bidder/i;
function isResultAnnouncement(item) {
  const text = [item.projectName, (item.summary && item.summary.zh), (item.summary && item.summary.en), (item.notes && item.notes.zh), (item.notes && item.notes.en)]
    .filter(Boolean).join(" ");
  return RESULT_NOTICE_PATTERN.test(text);
}

// The model often drops "成交公告"/"中标公告" from the project name it returns
// (e.g. "明诚学校试卷印刷定点议价成交公告" -> "明诚学校试卷印刷"), so the check above
// can't see it. This one looks at the ORIGINAL search result (title + snippet)
// the item's sourceUrl came from, which still carries the real notice title.
function normUrl(u) {
  return String(u || "").replace(/^https?:\/\//i, "").replace(/[?#].*$/, "").replace(/\.html?$/i, "").replace(/\/+$/, "").toLowerCase();
}
// Snippet text is only checked against a narrower pattern: an open tender's
// terms can legitimately say things like "确定成交供应商", so the broad words are
// reserved for the notice TITLE.
const RESULT_SNIPPET_PATTERN = /成交公告|成交公示|中标公告|结果公告|结果公示|三[、.]\s*成交信息|成交金额\s*[:：]|中标金额\s*[:：]|contract award|award notice/i;
function isResultByOriginalHit(item, hitByUrl) {
  const hit = hitByUrl.get(normUrl(item.sourceUrl));
  if (!hit) return false;
  return RESULT_NOTICE_PATTERN.test(String(hit.title || "")) || RESULT_SNIPPET_PATTERN.test(String(hit.content || ""));
}

// DOMESTIC AMOUNT RULE: domestic projects are only worth tracking at or above
// this budget / contract amount (RMB). A STATED amount below the threshold is
// skipped; an amount that is NOT stated is let through but flagged C / "needs
// verification" (see flagUnknownDomesticAmount) so a real big project isn't lost.
const DOMESTIC_MIN_BUDGET_CNY = 500000;
function extractAmountCNY(item) {
  if (typeof item.budgetAmountCNY === "number" && isFinite(item.budgetAmountCNY)) return item.budgetAmountCNY;
  if (typeof item.budgetAmountCNY === "string") {
    const n = Number(item.budgetAmountCNY.replace(/[,，\s]/g, ""));
    if (isFinite(n) && n > 0) return n;
  }
  const text = [item.projectName, item.quantity && item.quantity.zh, item.specs && item.specs.zh, item.summary && item.summary.zh, item.notes && item.notes.zh].filter(Boolean).join(" ");
  let m = text.match(/(\d+(?:\.\d+)?)\s*万元/);
  if (m) return Math.round(parseFloat(m[1]) * 10000);
  m = text.match(/(?:预算|金额|限价|报价)[^\d]{0,8}(\d[\d,]*(?:\.\d+)?)\s*元/);
  if (m) return Math.round(parseFloat(m[1].replace(/,/g, "")));
  return null;
}
function failsDomesticAmountRule(item) {
  if (item.region !== "domestic") return null;
  const amt = extractAmountCNY(item);
  if (amt === null) return null; // unknown amount: not rejected, flagged instead
  if (amt < DOMESTIC_MIN_BUDGET_CNY) return `amount ${amt} < ${DOMESTIC_MIN_BUDGET_CNY}`;
  return null;
}
// Unknown amount on a domestic item: keep it, but never above grade C, and say why.
function flagUnknownDomesticAmount(item) {
  if (item.region !== "domestic" || extractAmountCNY(item) !== null) return;
  item.amountUnverified = true;
  if (item.grade === "A" || item.grade === "B") {
    item.grade = "C";
    item.gradeLabel = { zh: "C-待核实（金额未写明）", en: "C — Needs verification (amount not stated)" };
  }
  const addZh = "公告未写明预算/金额，需核实是否达到50万元门槛。";
  const addEn = "No budget/amount stated in the notice; verify it meets the RMB 500,000 threshold.";
  const n = item.notes && typeof item.notes === "object" ? item.notes : { zh: item.notes || "", en: "" };
  item.notes = { zh: [n.zh, addZh].filter(Boolean).join(" "), en: [n.en, addEn].filter(Boolean).join(" ") };
}

function isBlockedDomain(link) {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return BLOCKED_DOMAINS.some(d => host === d || host.endsWith("." + d));
  } catch {
    return true; // if the URL doesn't even parse, don't trust it
  }
}

// ---------------------------------------------------------------------------
// World Bank official "Procurement Notice" open dataset (DS00979)
// ---------------------------------------------------------------------------
// Why this exists: projects.worldbank.org/.../procurement-detail/OPxxxxxxxx
// pages are rendered client-side (a JS single-page app) with no static,
// crawlable content for any search engine (verified: a brand-new notice's
// own reference number returns zero hits anywhere on the open web, even
// though the page itself is live and public). That means NO web-search-based
// pipeline — Bocha included — can ever reliably catch a fresh World Bank
// tender the moment it's published; search engines simply haven't (and may
// never) index the page.
//
// The World Bank separately publishes this same data as a structured, public,
// unauthenticated, daily-updated open dataset via its "Finances One" data
// catalog (CC-BY 4.0 license, dataset id DS00979, resource id RS00909). We
// call that API directly instead of relying on search for this platform.
// Docs: https://financesone.worldbank.org/api-explorer?id=DS00979
const WB_DATASET_ID = "DS00979";
const WB_RESOURCE_ID = "RS00909";
const WB_API_BASE = "https://datacatalogapi.worldbank.org/dexapps/fone/api";

// IMPORTANT: this World Bank dataset spans the bank's ENTIRE global
// procurement activity, not just education. A bare "print" match alone
// pulls in a huge amount of irrelevant noise that happens to involve
// printing — vinyl stickers, prescription pads, ID cards, VAT-awareness
// billboards, policy guideline booklets, etc. (confirmed empirically: of
// 17 "print"-matching rows in one real run, only 1 was actually about
// textbooks/workbooks/teacher's guides). So we require BOTH a printing verb
// AND a specific education/learning-material noun to be present, not either
// one alone.
const PRINT_TERM = /\bprint(?:ing|ed)?\b|re-?print/i;
const EDU_MATERIAL_TERM = /textbook|work\s*book|teacher'?s?\s*guide|learning material|exercise book|school\s*(?:text)?book|educational material|curriculum/i;
const PRINTING_KEYWORDS = { test: (s) => PRINT_TERM.test(s) && EDU_MATERIAL_TERM.test(s) };

function parseWbDate(s) {
  // World Bank API dates look like "DD-MMM-YYYY", e.g. "15-JUN-2026"
  if (!s) return null;
  const m = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})/);
  if (!m) return null;
  const months = { JAN:1,FEB:2,MAR:3,APR:4,MAY:5,JUN:6,JUL:7,AUG:8,SEP:9,OCT:10,NOV:11,DEC:12 };
  const mo = months[m[2].toUpperCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`; // YYYY-MM-DD
}

async function fetchWorldBankProcurementNotices() {
  console.log("Fetching World Bank official Procurement Notice dataset (DS00979)...");

  // The dataset has 400k+ historical rows in (apparently) ascending order, so
  // skip=0 would only return very old notices. Try to read the total row
  // count from the metadata endpoint so we can jump near the end (the most
  // recently added rows). If that fails for any reason, fall back to skip=0
  // rather than crashing the whole run.
  let skip = 0;
  try {
    const metaRes = await fetchWithTimeout(`${WB_API_BASE}/metadata?assetId=${WB_DATASET_ID}`, {}, 20000);
    if (metaRes.ok) {
      const metaText = await metaRes.text();
      const countMatch = metaText.match(/"(?:rowCount|row_count|totalRows|total_rows|recordCount|record_count|totalRecords|total_records)"\s*:\s*"?(\d+)/i);
      if (countMatch) {
        const total = parseInt(countMatch[1], 10);
        skip = Math.max(0, total - 3000);
        console.log(`  Dataset reports ~${total} total rows; fetching the most recent ~3000 (skip=${skip}).`);
      } else {
        console.log("  Could not find a row count in dataset metadata; defaulting to skip=0 (may miss recent rows).");
      }
    }
  } catch (e) {
    console.warn(`  Could not fetch World Bank dataset metadata (defaulting to skip=0): ${e.message}`);
  }

  let rows = [];
  try {
    const url = `${WB_API_BASE}/apiservice?datasetId=${WB_DATASET_ID}&resourceId=${WB_RESOURCE_ID}&top=3000&skip=${skip}&type=json`;
    const res = await fetchWithTimeout(url, {}, 45000);
    if (!res.ok) {
      console.warn(`  World Bank procurement API returned ${res.status}; skipping this source for this run.`);
      return [];
    }
    const data = await res.json();
    rows = Array.isArray(data) ? data : (data.data || data.value || data.records || data.Results || []);
  } catch (e) {
    console.warn(`  World Bank procurement API fetch failed (skipping this source for this run): ${e.message}`);
    return [];
  }
  console.log(`  Fetched ${rows.length} World Bank procurement notice rows (skip=${skip}).`);

  const keywordMatches = rows.filter(r => PRINTING_KEYWORDS.test(String(r.bid_description || r.BID_DESCRIPTION || "")));
  console.log(`  ${keywordMatches.length} row(s) match printing/textbook/workbook keywords.`);

  // The dataset mixes several notice_type values together — open calls for
  // bids (what we actually want), but also "Contract Award" notices (the
  // bidding is already over, a winner was already chosen, nothing left to
  // act on) and similar after-the-fact records (results/shortlists). Those
  // are real, correctly-sourced data, but they are NOT actionable tender
  // opportunities, so they should never appear in this dashboard at all —
  // not even downgraded to D. Filter them out here, before they're even
  // turned into project candidates.
  const NON_OPPORTUNITY_NOTICE_TYPE = /award|result|shortlist|debrief|disqualif/i;
  const matches = keywordMatches.filter(r => {
    const noticeType = String(r.notice_type || r.NOTICE_TYPE || "");
    return !NON_OPPORTUNITY_NOTICE_TYPE.test(noticeType);
  });
  if (matches.length !== keywordMatches.length) {
    console.log(`  Dropped ${keywordMatches.length - matches.length} row(s) whose notice_type is a contract-award/result record, not an open opportunity.`);
  }
  return matches;
}

function wbRowToProject(r) {
  const desc = String(r.bid_description || r.BID_DESCRIPTION || "").trim();
  const sourceUrl = r.url || r.URL;
  if (!desc || !sourceUrl) return null;

  const deadlineYmd = parseWbDate(r.deadline_date || r.DEADLINE_DATE);
  const publishYmd = parseWbDate(r.publication_date || r.PUBLICATION_DATE);
  const todayYmd = new Date().toISOString().slice(0, 10);
  const hasDeadline = !!deadlineYmd;
  const isOpen = hasDeadline && deadlineYmd >= todayYmd;
  const country = r.country_name || r.COUNTRY_NAME || "";

  const grade = isOpen ? "B" : (hasDeadline ? "D" : "C");
  const gradeLabel = isOpen
    ? { zh: "B-发邮件确认", en: "B — Confirm by email" }
    : hasDeadline
      ? { zh: "D-已错过/归档", en: "D — Missed / archived" }
      : { zh: "C-待核实", en: "C — Needs verification" };

  return {
    sample: false,
    verified: true,
    region: "international",
    discoveryDate: new Date().toISOString().slice(0, 10),
    sourcePlatform: "World Bank（官方Procurement Notice数据集 / official dataset API）",
    issuer: `World Bank${country ? " – " + country : ""}`,
    country: { zh: country, en: country },
    projectName: desc,
    projectNo: String(r.id || r.ID || r.project_id || r.PROJECT_ID || ""),
    projectType: { zh: "教材/学习材料印刷", en: "Textbook / learning material printing" },
    summary: { zh: desc, en: desc },
    fundingSource: "World Bank",
    publishDate: publishYmd || undefined,
    deadlineLocal: r.deadline_date || r.DEADLINE_DATE || undefined,
    deadlineBeijing: deadlineYmd ? `${deadlineYmd} 23:59` : undefined,
    sourceUrl,
    grade,
    gradeLabel,
    status: isOpen
      ? { zh: "新发现", en: "Newly discovered" }
      : hasDeadline
        ? { zh: "已过期", en: "Expired" }
        : { zh: "待核实", en: "Needs verification" },
    notes: {
      zh: `来自世界银行官方Procurement Notice开放数据集（直接调用官方API获取，不经过网页搜索/未经AI改写），字段为官方原始数据。通知类型：${r.notice_type || r.NOTICE_TYPE || "未知"}。`,
      en: `Sourced directly from the World Bank's official Procurement Notice open dataset API (not web search, not AI-rewritten) — fields are the raw official values. Notice type: ${r.notice_type || r.NOTICE_TYPE || "unknown"}.`
    }
  };
}

const SCHEMA_NOTE = `
Each project object MUST use this exact shape (omit a key entirely rather than guessing a value you can't verify from the search results below):
{
  "id": number,                 // omit for new items, script will assign
  "sample": false,
  "verified": true,
  "region": "international" | "domestic",   // REQUIRED — see rules below
  "discoveryDate": "YYYY-MM-DD",
  "sourcePlatform": string,
  "issuer": string,
  "country": {"zh": string, "en": string},
  "projectName": string,
  "projectNo": string,
  "projectType": {"zh": string, "en": string},
  "summary": {"zh": string, "en": string},
  "quantity": {"zh": string, "en": string},
  "specs": {"zh": string, "en": string},
  "fundingSource": string,
  "publishDate": "YYYY-MM-DD",
  "deadlineLocal": string,
  "deadlineBeijing": "YYYY-MM-DD HH:MM",
  "currency": string,
  "intlSuppliersAllowed": {"zh": string, "en": string},
  "locallyRestricted": {"zh": string, "en": string},
  "sourceUrl": string,          // REQUIRED — must be copied EXACTLY (character for character) from the "link" field of one of the search results provided below. Never invent or modify a URL.
  "keyContact": string,
  "budgetAmountCNY": number | null,   // DOMESTIC items only: budget / maximum price / contract amount in RMB (yuan) as a plain number — convert 万元 (×10000). null if the notice states no amount.
  "grade": "A" | "B" | "C" | "D",
  "gradeLabel": {"zh": string, "en": string},
  "nextAction": {"zh": string, "en": string},
  "status": {"zh": string, "en": string},
  "notes": {"zh": string, "en": string}
}

REGION & sourcePlatform RULES (read carefully — this has been a recurring error):
- "region" must be "international" if the tender is issued by a multilateral/international organization (UNICEF, World Bank, UNGM, ADB, UNESCO, GPE, ECW, UNHCR, UNRWA, USAID, FCDO, EU/TED, etc.) or a non-Chinese national government/agency.
- "region" must be "domestic" if the buyer is a mainland China entity — a Chinese school, university, hospital, local government procurement office, or a notice published on a Chinese public procurement site (e.g. 中国政府采购网, 省/市级政府采购网, 学校官网, 中国招标投标公共服务平台). This includes Chinese-language domestic tenders even if they happen to mention textbooks/workbooks.
- "sourcePlatform" MUST be the actual site/platform where the notice was found (e.g. "UNGM", "UNICEF Supply Division", "中国政府采购网", "XX市政府采购网", "学校官网"). NEVER use the name of a multilateral organization (UNICEF, World Bank, GPE, ADB, UNESCO, etc.) as sourcePlatform for a domestic Chinese tender just because the project involves education — that organization must have actually published the notice on its own official channel.
- If in doubt whether something is international or domestic, look at the issuer/buyer's location and the site it was published on, not just the subject matter. In particular: a Chinese publisher/institution tendering on a Chinese platform is "domestic" even if the book/material's SUBJECT concerns an international organization (e.g. printing a catalog of "UNESCO Intangible Cultural Heritage" volumes for a Chinese publisher, found on 千里马招标网/西藏招标网, is domestic — UNESCO didn't issue or fund that tender, it's just the topic of the book). Do not set "fundingSource" to an international organization's name just because it's mentioned in the project description — only set it if that organization is actually the buyer/funder of the tender itself.
- For "domestic" entries specifically, the sourceUrl MUST be from an official/primary source: a government procurement domain (contains gov.cn), the buying institution's own official site (e.g. a university's own *.edu.cn procurement page), or a recognized official procurement platform (中国政府采购网, 各省市政府采购网, 中国招标投标公共服务平台). Do NOT source a domestic entry from a general news portal, aggregator, or self-media account (e.g. sohu, sina, toutiao, baijiahao, weibo, douyin, WeChat public accounts) — these frequently rewrite real notices into promotional/clickbait articles ("XX采购：你绝对不能错过的机会！") that are not reliable even when the underlying fact is real. If the only source you can find for a domestic tender is this kind of article, leave it out.

SOURCE QUALITY RULES (read carefully — this has been a recurring error):
- A search result is only usable if it is an ACTUAL, SPECIFIC tender/procurement notice: it must reference a specific bid/reference number, a specific deadline, specific submission instructions, or a specific named buyer with a specific requirement. General guides, policy documents, training materials, handbooks, glossaries, news articles about a topic, case studies, program impact reports, academic papers/book chapters, or "how procurement works" explainers are NOT tenders — do not create a project from them even if they mention textbooks/printing/World Bank/UNICEF, and even if they are hosted on the organization's own official domain (e.g. a UNICEF case-study PDF at unicef.org/media/... is not a tender just because it's on unicef.org).
- NEVER use a result from a generic document-sharing / content-farm site as a source — these host random re-uploaded PDFs with no connection to a live tender and are not authoritative. Examples of domains to always reject: 原创力文档, 道客巴巴, 豆丁网, 百度文库, book118, max.book118.com, docin.com, wenku.baidu.com, coggle/slideshare-style generic upload sites. If the "link" domain looks like a generic document repository rather than an official organization/government/procurement platform, do not use it.
- Prefer results whose domain matches the organization's own official site (ungm.org, unicef.org, worldbank.org, adb.org, unesco.org, unhcr.org, unrwa.org, ted.europa.eu, dgmarket.com, devex.com, developmentaid.org, gov.cn / *.gov.cn / 中国政府采购网 and similar official government procurement portals).
- When unsure whether a result is a real, specific, current tender vs. background/reference material, leave it out rather than guessing.
- Some sources (e.g. bidsinfo.com and similar paid tender-aggregator sites) show only a summary publicly — title, country, closing date, reference number — and gate full details (buyer name, contact, full scope) behind a paid login. It's fine to create an entry from just the public summary IF it clearly names a specific tender with a specific closing date, but you MUST: (a) only fill in the fields you can actually see (leave the rest blank), (b) note in "openQuestions" or "notes" that full details require logging into the source site, and (c) never grade it A — treat it as B/C at most since eligibility and scope can't be confirmed without the gated content.

TITLE FIDELITY RULE: "projectName" must be the notice's ORIGINAL title as shown in the search result's "title"/content, word for word — do NOT shorten it or drop words such as 成交公告 / 中标公告 / 结果公示 / 议价成交 / 定点议价成交. (Dropping them hides that the notice is a result record.) If a result's title or text contains ANY of these, it is a RESULT notice: skip it.
- Another tell for result notices: sections like "成交信息 / 成交供应商 / 成交金额 / 中标供应商 / 中标金额" naming a winning company. A tender invitation never names a winner.

TENDER-vs-RESULT RULE (read carefully — applies to BOTH domestic and international, this has been a recurring error):
- Only create an entry for an OPEN opportunity — a notice inviting bids/quotations that a supplier could still act on, or at minimum a genuine call-for-bids record. Do NOT create an entry for an after-the-fact RESULT/AWARD record — a notice whose content is reporting who already won, that bidding has already closed, or that the contract is already signed. This applies regardless of language: Chinese 成交公告/中标公告/中标结果/成交结果/中标候选人公示/废标公告/流标公告 and English "Contract Award" / "Award Notice" / "Results Notice" / "Winning Bidder" are all RESULT records, not opportunities — even if they technically mention the original project/subject matter (e.g. "小学教辅本册印刷...竞价成交公告" is reporting a result, not inviting bids — skip it entirely, don't add it even as a D/expired entry).
- If a search result's content makes clear the award has already been decided (names a winning supplier/contractor, states a signed contract, or is explicitly labeled as a result/award notice), leave it out of "new" entirely rather than including it with a low grade — these aren't useful even as historical records for this dashboard.

DOMESTIC AMOUNT RULE (mandatory): the buyer only wants DOMESTIC projects of RMB 500,000 (50万元) or MORE. Fill "budgetAmountCNY" with the budget / maximum price / contract amount as a number whenever the notice states one. If a stated amount is BELOW 500,000, do NOT return the project at all (small school print jobs and "定点采购/议价" quotes are not wanted). If the notice does NOT state any amount, still return the project (it is a qualified-looking open tender) with "budgetAmountCNY": null and grade "C" — do not guess an amount. This rule does not apply to international tenders.

DOMESTIC SCOPE RULE (read carefully — this has been a recurring error):
- The buyer's business only prints textbooks, workbooks, teacher's guides, exam papers, and similar finished educational-content printing SERVICES. It does NOT buy/sell raw paper stock, office consumables, or generic advertising production.
- REJECT (do not create an entry) any domestic tender whose subject is purchasing raw materials/consumables rather than a printing/production service — e.g. titles containing "用纸采购" (paper stock procurement), "复印纸...订购" (copier-paper direct purchase), "纸张采购" (paper purchase), "耗材采购" (consumables purchase). These are buying blank paper, not commissioning a printing job — not relevant even though they mention "教材"/"教辅"/"印刷".
- REJECT generic, non-specific "文印、广告制作" (printing & advertising production) listings that don't name a specific educational-material printing scope (workbooks, exam papers, teaching manuals, etc.) — these are usually broad office-printing/signage contracts, not textbook/workbook printing.
- REJECT any domestic tender whose buyer is NOT an educational institution or education authority (a school, university, kindergarten, vocational college, education bureau/education publishing house). A tender from an unrelated government department (e.g. an environmental protection bureau, a transportation department) that happens to use the phrase "出版物印刷" (publication printing) is out of scope even if "印刷" appears in the title — check who the buyer actually is, not just the keyword.
- A domestic entry IS in scope when it's a school/education authority procuring printing SERVICES that plausibly cover instructional materials — textbooks, workbooks (教辅/练习册/作业本), teacher's handbooks/guides (教师用书/教师指导/教师工作手册), exam papers (试卷), or a general "印刷服务定点采购"/"出版物印刷框架协议" from a school (since that framework would cover the school's own instructional-material printing needs even without spelling out "教材" explicitly).

DEDUPLICATION RULE:
- Before proposing a "new" item, compare its projectName + issuer/country against BOTH the existing entries above AND the other items you are about to return. If the same underlying tender appears to be mirrored on multiple sites (same project name, same buyer, same subject), only include it ONCE — pick the most authoritative/official source URL.
- Match by projectName ALONE when deciding this, not projectName+issuer — a mirrored listing on a second aggregator site often has a vaguer/missing issuer ("未明确"/"Not specified") than the first, which would otherwise make them look like two different projects when they're the same one. When you do find a mirror pair, keep whichever copy has the MORE complete information (real issuer name, real project number) rather than the first one found.`;

async function fetchWithTimeout(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// --- Search/inference health tracking ---------------------------------
// If Bocha is out of balance (403) every search silently returns [] and the
// run still "succeeds". These counters let main() notice that and flag it in
// data.json (shown as a banner on the dashboard + a red workflow run).
const searchStats = { attempted: 0, failed: 0, authFailed: 0, firstError: null };
let modelError = null;
const AUTH_OR_QUOTA = /enough money|quota|permission|insufficient|unauthori[sz]ed|forbidden/i;
function noteSearchFailure(detail, status) {
  searchStats.failed++;
  if (status === 401 || status === 402 || status === 403 || AUTH_OR_QUOTA.test(String(detail))) searchStats.authFailed++;
  if (!searchStats.firstError) searchStats.firstError = String(detail).slice(0, 300);
}

async function bochaWebSearch(query, attempt = 1) {
  if (attempt === 1) searchStats.attempted++;
  let res;
  try {
    res = await fetchWithTimeout(`${BOCHA_SEARCH_BASE_URL}/web-search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOCHA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        freshness: SEARCH_FRESHNESS,
        summary: true,
        count: 10
      })
    });
  } catch (e) {
    console.warn(`Bocha web-search timed out/errored for "${query}": ${e.message}`);
    noteSearchFailure(e.message, 0);
    return [];
  }
  if (res.status === 429 && attempt < 3) {
    const waitMs = 3000 * attempt;
    console.warn(`Bocha rate-limited on "${query}", retrying in ${waitMs}ms (attempt ${attempt})...`);
    await new Promise(r => setTimeout(r, waitMs));
    return bochaWebSearch(query, attempt + 1);
  }
  if (!res.ok) {
    const errText = await res.text();
    console.warn(`Bocha web-search failed for "${query}": ${res.status} ${errText}`);
    noteSearchFailure(`${res.status} ${errText}`, res.status);
    return [];
  }
  const data = await res.json();
  const items = data?.data?.webPages?.value || data?.webPages?.value || [];
  return items.map(r => ({
    query,
    title: r.name,
    link: r.url,
    content: r.summary || r.snippet,
    publish_date: r.datePublished
  }));
}

async function bochaChat(prompt, attempt = 1) {
  let res;
  try {
    res = await fetchWithTimeout(`${BOCHA_MODEL_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOCHA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        thinking: { type: "disabled" } // 关闭深度思考模式，避免生成大量额外思考token导致超时
      })
    }, 180000); // 单次最多等180秒
  } catch (e) {
    if (attempt < 3) {
      console.warn(`Bocha Model API timed out/errored (attempt ${attempt}): ${e.message}. Retrying...`);
      await new Promise(r => setTimeout(r, 3000));
      return bochaChat(prompt, attempt + 1);
    }
    throw new Error(`Bocha Model API failed after ${attempt} attempts: ${e.message}`);
  }
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 3) {
      const waitMs = 5000 * attempt;
      console.warn(`Bocha Model API returned ${res.status} (attempt ${attempt}), retrying in ${waitMs}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
      return bochaChat(prompt, attempt + 1);
    }
  }
  if (!res.ok) {
    throw new Error(`Bocha Model API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function buildPrompt(existingProjects, searchHits) {
  const existingSummary = existingProjects.map(p => ({
    id: p.id,
    region: p.region || "international",
    sourcePlatform: p.sourcePlatform,
    projectName: p.projectName,
    status: p.status,
    sourceUrl: p.sourceUrl || null
  }));

  return `You are refreshing a live tender-monitoring dashboard for a printing company that
prints textbooks, workbooks, and teacher's guides for international buyers (UNICEF, World Bank,
UNGM, ADB, and similar). Today's date is ${new Date().toISOString().slice(0, 10)}.

STRICT RULES:
- Only create a project entry if it is clearly supported by one of the search results listed below.
- The "sourceUrl" field MUST be copied character-for-character from a "link" value in the search results. Never invent, guess, or modify a URL.
- If a search result is irrelevant (not about textbook/workbook/teacher's-guide printing), ignore it.
- Do NOT create an entry based on speculation about what a document "might include" or "likely contains" (e.g. summarizing a result as "可能包括教育材料印刷" / "likely includes printing of educational materials"). If the search result content doesn't clearly and specifically confirm the tender is for printing (not just generic "educational materials" or "supplies"), leave it out rather than guessing.
- Do NOT create an entry from a generic listing, index, calendar, or "current tenders" hub page (e.g. a page that just links out to many opportunities, like a "tender calendar" or a platform's homepage). Only create an entry for a specific, individually identifiable tender/procurement notice with its own reference number or clearly single subject matter. If a result is a hub page, ignore it (you may still use it to decide which platform to search further, but do not turn it into a project row).
- If you are unsure about a field (deadline, quantity, etc.), omit that field rather than guessing.
- Grade A = clearly open, international suppliers allowed, worth acting on today.
  Grade B = open but needs a clarifying email (eligibility, local-only ambiguity, etc).
  Grade C = open but low priority / long runway.
  Grade D = closed, expired, or disqualifying restriction (e.g. local suppliers only).

DEADLINE / RECENCY RULE (read carefully — this has been a recurring error):
- NEVER assign grade A or B unless you can see a specific deadline date in the search result content AND that date is on or after today (${new Date().toISOString().slice(0, 10)}). "Invitation to bid" or similar wording does NOT by itself mean the tender is still open — many procurement portals keep old, expired notices permanently online and searchable.
- Reference/project numbers often encode a year (e.g. "LITB-2024-9190307", "ITB-2025-...") — if the number implies a year clearly in the past relative to today, treat the tender as very likely expired (grade D) even if no explicit deadline is visible, unless the search result content explicitly confirms it is still open.
- If you cannot find or confirm a specific, still-valid deadline for a result, grade it C at most (never A or B), and set status/notes to say the deadline could not be confirmed and needs verification — do not present it as an urgent, actionable opportunity.

Existing tracked entries (for context — check if any search result updates their status):
${JSON.stringify(existingSummary, null, 2)}

Raw search results (title / link / snippet / publish_date):
${JSON.stringify(searchHits, null, 2)}

${SCHEMA_NOTE}

Return ONLY a JSON object, no prose, no markdown fences, with this shape:
{
  "updates": [ { "id": <existing id>, ...only fields that changed... } ],
  "new": [ <full project objects for genuinely new tenders supported by the search results> ]
}
If nothing new or changed, return {"updates": [], "new": []}.`;
}

function recomputeDays(p) {
  if (p.deadlineBeijing) {
    const m = String(p.deadlineBeijing).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const deadline = Date.UTC(+m[1], +m[2] - 1, +m[3]) - 8 * 3600 * 1000;
      p.daysRemaining = Math.round((deadline - Date.now()) / 86400000);
    }
  }
  return p;
}

async function main() {
  const raw = await readFile(DATA_PATH, "utf8");
  const data = JSON.parse(raw);
  const projects = data.projects || [];

  console.log(`Loaded ${projects.length} existing projects.`);

  // Kick off the World Bank official dataset fetch in parallel with the web
  // searches below — it's an independent source, no need to wait for it.
  const wbRowsPromise = fetchWorldBankProcurementNotices().catch(e => {
    console.warn(`World Bank official dataset fetch threw unexpectedly: ${e.message}`);
    return [];
  });

  console.log("Running web searches...");

  let searchHits = [];
  const BATCH_SIZE = 4;
  for (let i = 0; i < SEARCH_QUERIES.length; i += BATCH_SIZE) {
    const batch = SEARCH_QUERIES.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(q => bochaWebSearch(q)));
    batchResults.forEach((hits, j) => {
      console.log(`  "${batch[j]}" -> ${hits.length} results`);
      searchHits = searchHits.concat(hits);
    });
  }

  const wbRows = await wbRowsPromise;
  const wbCandidates = wbRows.map(wbRowToProject).filter(Boolean);

  // Drop known generic document-sharing / content-farm domains before they ever reach the model
  const beforeBlock = searchHits.length;
  searchHits = searchHits.filter(h => h.link && !isBlockedDomain(h.link));
  if (beforeBlock !== searchHits.length) {
    console.log(`Dropped ${beforeBlock - searchHits.length} result(s) from blocked document-sharing domains.`);
  }

  // De-duplicate by link
  const seen = new Set();
  searchHits = searchHits.filter(h => {
    if (!h.link || seen.has(h.link)) return false;
    seen.add(h.link);
    return true;
  });

  console.log(`Collected ${searchHits.length} unique search results.`);
  const hitByUrl = new Map(searchHits.map(h => [normUrl(h.link), h]));

  // Fair share per query: results are ordered by query, so a plain "first 50"
  // cap lets the first queries (UNGM/UNICEF/World Bank/ADB) crowd out the
  // later ones (domestic gov.cn, bidsinfo...). Keep at most N hits per query.
  const MAX_HITS_PER_QUERY = 4;
  const perQueryCount = new Map();
  const beforePerQuery = searchHits.length;
  searchHits = searchHits.filter(h => {
    const n = perQueryCount.get(h.query) || 0;
    if (n >= MAX_HITS_PER_QUERY) return false;
    perQueryCount.set(h.query, n + 1);
    return true;
  });
  if (beforePerQuery !== searchHits.length) {
    console.log(`Kept at most ${MAX_HITS_PER_QUERY} results per query: ${beforePerQuery} -> ${searchHits.length}.`);
  }

  const MAX_HITS_FOR_MODEL = 50;
  let trimmedHits = searchHits.map(h => ({
    ...h,
    content: h.content ? String(h.content).slice(0, 200) : h.content
  }));
  if (trimmedHits.length > MAX_HITS_FOR_MODEL) {
    console.log(`Capping ${trimmedHits.length} results down to ${MAX_HITS_FOR_MODEL} for the model call.`);
    trimmedHits = trimmedHits.slice(0, MAX_HITS_FOR_MODEL);
  }
  // Diagnostics: show exactly which search results the model is given, so a
  // "No changes found" run can be told apart from "nothing relevant was searched".
  console.log(`Search results sent to the model (${trimmedHits.length}):`);
  trimmedHits.forEach((h, i) => console.log(`  [${i + 1}] ${String(h.title || "").slice(0, 70)} | ${String(h.link || "").slice(0, 90)}`));
  console.log("Calling Bocha Model API (DeepSeek V4) to extract...");
  let raw2 = "";
  try {
    raw2 = await bochaChat(buildPrompt(projects, trimmedHits));
  } catch (e) {
    // Don't let an inference-step failure take down the whole run: the
    // World Bank official-dataset candidates below don't depend on this
    // call at all, and we still want them merged + written to data.json
    // even if Bocha's Model API is having a bad day.
    modelError = String(e.message || e);
    console.warn(`Bocha Model API extraction failed, continuing without web-search-derived updates: ${e.message}`);
  }
  const cleaned = raw2.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  let updates = [];
  let newItems = [];
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      updates = parsed.updates || [];
      newItems = parsed.new || [];
      console.log(`Model returned ${newItems.length} new item(s) and ${updates.length} update(s).`);
      newItems.forEach(it => console.log(`  model proposed: [${it.region || "?"}] ${String(it.projectName || "").slice(0, 80)} | amount=${it.budgetAmountCNY ?? "null"} | grade=${it.grade || "?"}`));
    } catch (e) {
      console.warn("Failed to parse GLM JSON output:", e.message);
      console.warn("Raw output was:", raw2.slice(0, 2000));
    }
  } else {
    console.warn("No JSON object found in GLM output. Raw output:", raw2.slice(0, 2000));
  }

  let changed = false;
  const validLinks = new Set(searchHits.map(h => h.link));

function sanityCheckGrade(item) {
  const zh = (v) => (v && typeof v === "object" ? v.zh : v);
  const setBothLang = (field, zhText, enText) => {
    item[field] = { zh: zhText, en: enText };
  };

  // Try to parse an explicit deadline
  let deadlineDate = null;
  if (item.deadlineBeijing) {
    const m = String(item.deadlineBeijing).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) deadlineDate = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  }
  const today = new Date(new Date().toISOString().slice(0, 10));

  // If we have a real deadline and it's already passed, force D + expired status
  if (deadlineDate && deadlineDate < today) {
    if (item.grade !== "D") {
      console.warn(`Auto-downgrading #${item.projectName || item.sourcePlatform}: deadline ${item.deadlineBeijing} has passed -> grade D`);
    }
    item.grade = "D";
    setBothLang("gradeLabel", "D-已错过/归档", "D — Missed / archived");
    setBothLang("status", "已过期", "Expired");
    return item;
  }

  // Check project number for an embedded year that's clearly in the past
  const yearMatch = String(item.projectNo || "").match(/\b(20\d{2})\b/);
  const currentYear = new Date().getFullYear();
  const looksStaleByNumber = yearMatch && parseInt(yearMatch[1], 10) < currentYear;

  // No confirmed future deadline, but grade claims urgency -> downgrade
  if ((item.grade === "A" || item.grade === "B") && !deadlineDate) {
    console.warn(`Auto-downgrading #${item.projectName || item.sourcePlatform}: grade ${item.grade} but no confirmed deadline -> grade C`);
    item.grade = "C";
    setBothLang("gradeLabel", "C-待核实", "C — Needs verification");
    setBothLang(
      "notes",
      ((zh(item.notes) || "") + " [自动降级：未能确认具体截止日期，需人工核实是否仍然有效]").trim(),
      ((item.notes && item.notes.en) || "") + " [Auto-downgraded: no confirmed deadline found, needs manual verification]"
    );
  }

  if (looksStaleByNumber && item.grade !== "D") {
    console.warn(`Auto-downgrading #${item.projectName || item.sourcePlatform}: projectNo suggests year ${yearMatch[1]}, likely stale -> grade D`);
    item.grade = "D";
    setBothLang("gradeLabel", "D-可能已过期", "D — Likely expired");
    setBothLang("status", "可能已过期", "Likely expired");
    setBothLang(
      "notes",
      ((zh(item.notes) || "") + ` [自动降级：编号中的年份(${yearMatch[1]})早于当前年份，很可能已过期，需人工核实]`).trim(),
      ((item.notes && item.notes.en) || "") + ` [Auto-downgraded: reference number implies year ${yearMatch[1]}, likely expired, needs manual verification]`
    );
  }

  // Final consistency check: the LLM sometimes sets "status" to say expired
  // (e.g. because the publish date is clearly old) in one pass, without the
  // "grade"/"gradeLabel" fields getting the matching downgrade — producing a
  // contradictory record (e.g. status "已过期" but grade still "C-低优先级").
  // Whatever the grade logic above decided, if status says expired/missed,
  // force the grade to match so the badge and the status text never disagree.
  const statusText = `${zh(item.status) || ""} ${(item.status && item.status.en) || ""}`;
  const statusSaysExpired = /已过期|已错过|expired|missed/i.test(statusText);
  if (statusSaysExpired && item.grade !== "D") {
    console.warn(`Auto-downgrading #${item.projectName || item.sourcePlatform}: status says expired but grade was ${item.grade} -> grade D`);
    item.grade = "D";
    setBothLang("gradeLabel", "D-已错过/归档", "D — Missed / archived");
  }

  return item;
}

  for (const upd of updates) {
    const target = projects.find(p => p.id === upd.id);
    if (target) {
      Object.assign(target, upd, { id: target.id });
      sanityCheckGrade(target);
      changed = true;
      console.log(`Updated project #${target.id}: ${target.projectName || target.sourcePlatform}`);
    }
  }

function normalizeKey(name, issuer) {
  return [name, issuer].filter(Boolean).join("|").toLowerCase().replace(/\s+/g, " ").trim();
}

// "未明确"/"Not specified"/etc. are placeholder non-values the LLM fills in
// when a field genuinely isn't visible in the source — not a real issuer
// name. When one mirrored listing has a real issuer and another (same
// underlying tender, different aggregator site) has a placeholder issuer,
// normalizeKey(name, issuer) produces two DIFFERENT keys and the dedup check
// misses it (seen in practice: the same 图书印刷项目 added twice from
// 千里马招标网 and 西藏招标网, one with issuer "未明确"). Fall back to
// matching on projectName alone whenever either side's issuer is a
// placeholder.
const PLACEHOLDER_VALUE = /^(未明确|未说明|not specified|tbd|n\/a|unknown)?$/i;
function isPlaceholderIssuer(v) {
  return PLACEHOLDER_VALUE.test(String(v || "").trim());
}
function normalizeNameOnlyKey(name) {
  return String(name || "").toLowerCase().replace(/\s+/g, " ").trim();
}

  let nextId = projects.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;
  const existingUrls = new Set(projects.map(p => p.sourceUrl).filter(Boolean));
  const existingNameKeys = new Set(projects.map(p => normalizeKey(p.projectName, p.issuer)).filter(Boolean));
  const existingNameOnlyKeys = new Set(projects.map(p => normalizeNameOnlyKey(p.projectName)).filter(Boolean));
  const placeholderIssuerNameOnlyKeys = new Set(
    projects.filter(p => isPlaceholderIssuer(p.issuer)).map(p => normalizeNameOnlyKey(p.projectName)).filter(Boolean)
  );
  function isMirroredDuplicate(item) {
    const nameOnlyKey = normalizeNameOnlyKey(item.projectName);
    if (!nameOnlyKey) return false;
    // Either side having a placeholder issuer means normalizeKey(name,issuer)
    // won't match a real-issuer twin of the same tender — fall back to
    // matching on the project name alone in that case.
    if (placeholderIssuerNameOnlyKeys.has(nameOnlyKey)) return true;
    if (isPlaceholderIssuer(item.issuer) && existingNameOnlyKeys.has(nameOnlyKey)) return true;
    return false;
  }
  function trackNameKeys(item) {
    const nameOnlyKey = normalizeNameOnlyKey(item.projectName);
    if (nameOnlyKey) {
      existingNameOnlyKeys.add(nameOnlyKey);
      if (isPlaceholderIssuer(item.issuer)) placeholderIssuerNameOnlyKeys.add(nameOnlyKey);
    }
  }

  // Merge World Bank official-dataset candidates first (most trustworthy —
  // structured official data, not AI-extracted) so later LLM-derived
  // duplicates of the same tender get skipped by the dedup checks below.
  for (const item of wbCandidates) {
    if (existingUrls.has(item.sourceUrl)) continue; // already tracked
    const nameKey = normalizeKey(item.projectName, item.issuer);
    if (nameKey && existingNameKeys.has(nameKey)) continue;
    if (isMirroredDuplicate(item)) continue;
    item.id = nextId++;
    sanityCheckGrade(item);
    projects.push(item);
    existingUrls.add(item.sourceUrl);
    if (nameKey) existingNameKeys.add(nameKey);
    trackNameKeys(item);
    changed = true;
    console.log(`Added new project #${item.id} (World Bank official dataset): ${item.projectName}`);
  }

  for (const item of newItems) {
    if (!item.sourceUrl || !validLinks.has(item.sourceUrl)) {
      console.warn("Skipping new item with missing/unverified sourceUrl:", item.projectName);
      continue;
    }
    if (existingUrls.has(item.sourceUrl)) {
      console.warn(`Skipping duplicate: sourceUrl already tracked -> ${item.sourceUrl} (${item.projectName})`);
      continue;
    }
    if (isOffScopeDomestic(item)) {
      console.warn(`Skipping out-of-scope domestic item (raw paper/consumables/ad-production, not a printing service): ${item.projectName}`);
      continue;
    }
    if (isResultAnnouncement(item) || isResultByOriginalHit(item, hitByUrl)) {
      console.warn(`Skipping award/result announcement (bidding already closed, not an open opportunity): ${item.projectName}`);
      continue;
    }
    const amountFail = failsDomesticAmountRule(item);
    if (amountFail) {
      console.warn(`Skipping domestic item below the RMB ${DOMESTIC_MIN_BUDGET_CNY} budget rule (${amountFail}): ${item.projectName}`);
      continue;
    }
    const nameKey = normalizeKey(item.projectName, item.issuer);
    if (nameKey && existingNameKeys.has(nameKey)) {
      console.warn(`Skipping duplicate: same project name+issuer already tracked (mirrored source?) -> ${item.projectName}`);
      continue;
    }
    if (isMirroredDuplicate(item)) {
      console.warn(`Skipping duplicate: same project name tracked already (issuer unclear on one side, likely mirrored across aggregator sites) -> ${item.projectName}`);
      continue;
    }
    item.id = nextId++;
    item.sample = false;
    item.verified = true;
    item.region = item.region === "domestic" ? "domestic" : "international";
    sanityCheckGrade(item);
    flagUnknownDomesticAmount(item);
    projects.push(item);
    existingUrls.add(item.sourceUrl);
    if (nameKey) existingNameKeys.add(nameKey);
    trackNameKeys(item);
    changed = true;
    console.log(`Added new project #${item.id}: ${item.projectName}`);
  }

  projects.forEach(recomputeDays);

  if (changed) {
    data.projects = projects;
  }
  data.lastUpdated = new Date().toISOString();

  // Record whether the search/inference services actually worked this run.
  const allSearchesFailed = searchStats.attempted > 0 && searchStats.failed === searchStats.attempted;
  const modelAuthFailed = !!modelError && AUTH_OR_QUOTA.test(modelError);
  let healthStatus = "ok";
  if (allSearchesFailed || modelAuthFailed) healthStatus = "down";
  else if (searchStats.failed > 0 || modelError) healthStatus = "degraded";
  const quotaLikely = searchStats.authFailed > 0 || modelAuthFailed;
  data.searchHealth = {
    status: healthStatus,
    checkedAt: data.lastUpdated,
    searches: { attempted: searchStats.attempted, failed: searchStats.failed },
    modelError: modelError ? modelError.slice(0, 300) : null,
    message: healthStatus === "ok" ? null : {
      zh: quotaLikely
        ? "博查搜索服务调用失败（余额不足或权限问题），本次只更新了世界银行官方数据，其他平台未检索，下方“无新项目”不代表真的没有。请检查博查账户余额。"
        : "部分或全部联网搜索失败，本次数据可能不完整，下方“无新项目”不代表真的没有。请查看 Actions 运行日志。",
      en: quotaLikely
        ? "Bocha search service calls failed (insufficient balance or permission). Only the World Bank official dataset was refreshed this run; other platforms were NOT searched, so “no new projects” may be wrong. Please check the Bocha account balance."
        : "Some or all web searches failed this run; data may be incomplete, so “no new projects” may be wrong. Check the Actions run log."
    }
  };
  if (healthStatus !== "ok") {
    console.error(`SEARCH HEALTH: ${healthStatus} (searches failed ${searchStats.failed}/${searchStats.attempted}${modelError ? `; model error: ${modelError.slice(0, 120)}` : ""})`);
  }

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(changed ? "data.json updated." : "No changes found; refreshed timestamp only.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
