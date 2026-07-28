#!/usr/bin/env node
/**
 * update_tenders.mjs — 博查(Bocha) 搜索 + 智谱(GLM) 推理 混合版
 *
 * 两步走：
 *   1. 调用博查 Web Search API（真实结构化搜索结果，含真链接），
 *      对多个关键词分别搜索 UNGM / UNICEF / World Bank / ADB 等平台上的
 *      教材/作业册/教师指南印刷招标（走博查免费资源包额度，不花钱）
 *   2. 把搜到的原始结果（连同已有的 data.json）一起交给智谱GLM模型，
 *      让它只从"确实搜到的真实链接"里提炼出结构化项目，绝不编造项目或链接
 *      （走智谱账户里本来就有的免费token额度，不花钱）
 *
 * 环境变量：
 *   BOCHA_API_KEY   必填，博查AI开放平台的 API Key（用于搜索）
 *   ZHIPU_API_KEY   必填，智谱开放平台的 API Key（用于推理/提炼）
 *   GLM_MODEL       可选，默认 glm-4.5-air
 *
 * 手动运行：
 *   BOCHA_API_KEY=xxxx ZHIPU_API_KEY=xxxx node scripts/update_tenders.mjs
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

const ZHIPU_API_KEY = process.env.ZHIPU_API_KEY;
if (!ZHIPU_API_KEY) {
  console.error("Missing ZHIPU_API_KEY environment variable.");
  process.exit(1);
}

const MODEL = process.env.GLM_MODEL || "glm-4.5-air";
const ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/paas/v4";
const BOCHA_BASE_URL = "https://api.bochaai.com/v1";

const INTL_QUERIES = [
  "UNGM tender printing textbooks workbooks",
  "UNICEF supply printing workbooks teacher guide tender",
  "World Bank procurement notice printing textbooks",
  "ADB invitation for bids printing textbooks learning materials",
  "UNESCO UNHCR UNRWA printing textbooks tender",
  "GPE ECW education printing materials tender",
  "dgMarket Devex printing textbooks tender",
  "TED europa printing textbooks tender"
];

const DOMESTIC_QUERIES = [
  "教材印刷 中标公告 中国政府采购网",
  "教辅资料印刷服务 招标公告",
  "学校 教材印刷 采购公告"
];

const SEARCH_QUERIES = [...INTL_QUERIES, ...DOMESTIC_QUERIES];

// Generic document-sharing / content-farm sites that frequently host unrelated,
// re-uploaded PDFs (procurement guides, textbooks, etc.) with no connection to a
// live tender. Results from these domains are dropped before they ever reach the model.
const BLOCKED_DOMAINS = [
  "book118.com", "max.book118.com", "docin.com", "wenku.baidu.com",
  "doc88.com", "doc.mbalib.com", "docs.qq.com", "coggle.it",
  "renrendoc.com", "zhuanlan.zhihu.com", "jz.docin.com", "taodocs.com",
  "docerpro.com", "mianfeiwendang.com", "chinaacc.com", "ppt.docin.com"
];

function isBlockedDomain(link) {
  try {
    const host = new URL(link).hostname.toLowerCase();
    return BLOCKED_DOMAINS.some(d => host === d || host.endsWith("." + d));
  } catch {
    return true; // if the URL doesn't even parse, don't trust it
  }
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
- If in doubt whether something is international or domestic, look at the issuer/buyer's location and the site it was published on, not just the subject matter.

SOURCE QUALITY RULES (read carefully — this has been a recurring error):
- A search result is only usable if it is an ACTUAL, SPECIFIC tender/procurement notice: it must reference a specific bid/reference number, a specific deadline, specific submission instructions, or a specific named buyer with a specific requirement. General guides, policy documents, training materials, handbooks, glossaries, news articles about a topic, case studies, program impact reports, academic papers/book chapters, or "how procurement works" explainers are NOT tenders — do not create a project from them even if they mention textbooks/printing/World Bank/UNICEF, and even if they are hosted on the organization's own official domain (e.g. a UNICEF case-study PDF at unicef.org/media/... is not a tender just because it's on unicef.org).
- NEVER use a result from a generic document-sharing / content-farm site as a source — these host random re-uploaded PDFs with no connection to a live tender and are not authoritative. Examples of domains to always reject: 原创力文档, 道客巴巴, 豆丁网, 百度文库, book118, max.book118.com, docin.com, wenku.baidu.com, coggle/slideshare-style generic upload sites. If the "link" domain looks like a generic document repository rather than an official organization/government/procurement platform, do not use it.
- Prefer results whose domain matches the organization's own official site (ungm.org, unicef.org, worldbank.org, adb.org, unesco.org, unhcr.org, unrwa.org, ted.europa.eu, dgmarket.com, devex.com, developmentaid.org, gov.cn / *.gov.cn / 中国政府采购网 and similar official government procurement portals).
- When unsure whether a result is a real, specific, current tender vs. background/reference material, leave it out rather than guessing.

DEDUPLICATION RULE:
- Before proposing a "new" item, compare its projectName + issuer/country against BOTH the existing entries above AND the other items you are about to return. If the same underlying tender appears to be mirrored on multiple sites (same project name, same buyer, same subject), only include it ONCE — pick the most authoritative/official source URL.`;

async function fetchWithTimeout(url, options, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bochaWebSearch(query, attempt = 1) {
  let res;
  try {
    res = await fetchWithTimeout(`${BOCHA_BASE_URL}/web-search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BOCHA_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        query,
        freshness: "noLimit",
        summary: true,
        count: 10
      })
    });
  } catch (e) {
    console.warn(`Bocha web-search timed out/errored for "${query}": ${e.message}`);
    return [];
  }
  if (res.status === 429 && attempt < 3) {
    const waitMs = 3000 * attempt;
    console.warn(`Bocha rate-limited on "${query}", retrying in ${waitMs}ms (attempt ${attempt})...`);
    await new Promise(r => setTimeout(r, waitMs));
    return bochaWebSearch(query, attempt + 1);
  }
  if (!res.ok) {
    console.warn(`Bocha web-search failed for "${query}": ${res.status} ${await res.text()}`);
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

async function zhipuChat(prompt) {
  const res = await fetchWithTimeout(`${ZHIPU_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ZHIPU_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  }, 180000); // 推理这一步内容较多，给180秒兜底
  if (!res.ok) {
    throw new Error(`GLM chat error: ${res.status} ${await res.text()}`);
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
- Do NOT create an entry from a generic listing, index, calendar, or "current tenders" hub page (e.g. a page that just links out to many opportunities, like a "tender calendar" or a platform's homepage). Only create an entry for a specific, individually identifiable tender/procurement notice with its own reference number or clearly single subject matter. If a result is a hub page, ignore it (you may still use it to decide which platform to search further, but do not turn it into a project row).
- If you are unsure about a field (deadline, quantity, etc.), omit that field rather than guessing.
- Grade A = clearly open, international suppliers allowed, worth acting on today.
  Grade B = open but needs a clarifying email (eligibility, local-only ambiguity, etc).
  Grade C = open but low priority / long runway.
  Grade D = closed, expired, or disqualifying restriction (e.g. local suppliers only).

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
  const MAX_HITS_FOR_MODEL = 50;
  let trimmedHits = searchHits.map(h => ({
    ...h,
    content: h.content ? String(h.content).slice(0, 200) : h.content
  }));
  if (trimmedHits.length > MAX_HITS_FOR_MODEL) {
    console.log(`Capping ${trimmedHits.length} results down to ${MAX_HITS_FOR_MODEL} for the model call.`);
    trimmedHits = trimmedHits.slice(0, MAX_HITS_FOR_MODEL);
  }
  console.log("Calling GLM to extract...");
  const raw2 = await zhipuChat(buildPrompt(projects, trimmedHits));
  const cleaned = raw2.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  let updates = [];
  let newItems = [];
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      updates = parsed.updates || [];
      newItems = parsed.new || [];
    } catch (e) {
      console.warn("Failed to parse GLM JSON output:", e.message);
      console.warn("Raw output was:", raw2.slice(0, 2000));
    }
  } else {
    console.warn("No JSON object found in GLM output. Raw output:", raw2.slice(0, 2000));
  }

  let changed = false;
  const validLinks = new Set(searchHits.map(h => h.link));

  for (const upd of updates) {
    const target = projects.find(p => p.id === upd.id);
    if (target) {
      Object.assign(target, upd, { id: target.id });
      changed = true;
      console.log(`Updated project #${target.id}: ${target.projectName || target.sourcePlatform}`);
    }
  }

function normalizeKey(name, issuer) {
  return [name, issuer].filter(Boolean).join("|").toLowerCase().replace(/\s+/g, " ").trim();
}

  let nextId = projects.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;
  const existingUrls = new Set(projects.map(p => p.sourceUrl).filter(Boolean));
  const existingNameKeys = new Set(projects.map(p => normalizeKey(p.projectName, p.issuer)).filter(Boolean));
  for (const item of newItems) {
    if (!item.sourceUrl || !validLinks.has(item.sourceUrl)) {
      console.warn("Skipping new item with missing/unverified sourceUrl:", item.projectName);
      continue;
    }
    if (existingUrls.has(item.sourceUrl)) {
      console.warn(`Skipping duplicate: sourceUrl already tracked -> ${item.sourceUrl} (${item.projectName})`);
      continue;
    }
    const nameKey = normalizeKey(item.projectName, item.issuer);
    if (nameKey && existingNameKeys.has(nameKey)) {
      console.warn(`Skipping duplicate: same project name+issuer already tracked (mirrored source?) -> ${item.projectName}`);
      continue;
    }
    item.id = nextId++;
    item.sample = false;
    item.verified = true;
    item.region = item.region === "domestic" ? "domestic" : "international";
    projects.push(item);
    existingUrls.add(item.sourceUrl);
    if (nameKey) existingNameKeys.add(nameKey);
    changed = true;
    console.log(`Added new project #${item.id}: ${item.projectName}`);
  }

  projects.forEach(recomputeDays);

  if (changed) {
    data.projects = projects;
  }
  data.lastUpdated = new Date().toISOString();

  await writeFile(DATA_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(changed ? "data.json updated." : "No changes found; refreshed timestamp only.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
