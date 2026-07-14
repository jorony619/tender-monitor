#!/usr/bin/env node
/**
 * update_tenders.mjs — 智谱AI (BigModel/GLM) 版本
 *
 * 两步走：
 *   1. 调用智谱 Web Search API（真实结构化搜索结果，含真链接），
 *      对多个关键词分别搜索 UNGM / UNICEF / World Bank / ADB 等平台上的
 *      教材/作业册/教师指南印刷招标
 *   2. 把搜到的原始结果（连同已有的 data.json）一起交给 GLM 模型，
 *      让它只从"确实搜到的真实链接"里提炼出结构化项目，绝不编造项目或链接
 *
 * 环境变量：
 *   ZHIPU_API_KEY  必填，智谱开放平台的 API Key
 *   GLM_MODEL      可选，默认 glm-4-plus
 *
 * 手动运行：
 *   ZHIPU_API_KEY=xxxx node scripts/update_tenders.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");

const API_KEY = process.env.ZHIPU_API_KEY;
if (!API_KEY) {
  console.error("Missing ZHIPU_API_KEY environment variable.");
  process.exit(1);
}

const MODEL = process.env.GLM_MODEL || "glm-4-plus";
const BASE_URL = "https://open.bigmodel.cn/api/paas/v4";

const SEARCH_QUERIES = [
  "UNGM tender printing textbooks workbooks",
  "UNICEF supply printing workbooks teacher guide tender",
  "World Bank procurement notice printing textbooks",
  "ADB invitation for bids printing textbooks learning materials",
  "UNESCO UNHCR UNRWA printing textbooks tender",
  "GPE ECW education printing materials tender",
  "dgMarket Devex printing textbooks tender",
  "TED europa printing textbooks tender"
];

const SCHEMA_NOTE = `
Each project object MUST use this exact shape (omit a key entirely rather than guessing a value you can't verify from the search results below):
{
  "id": number,                 // omit for new items, script will assign
  "sample": false,
  "verified": true,
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
}`;

async function zhipuWebSearch(query) {
  const res = await fetch(`${BASE_URL}/web_search`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      search_query: query,
      search_engine: "search_pro",
      search_intent: false,
      count: 10,
      search_recency_filter: "noLimit"
    })
  });
  if (!res.ok) {
    console.warn(`web_search failed for "${query}": ${res.status} ${await res.text()}`);
    return [];
  }
  const data = await res.json();
  return (data.search_result || []).map(r => ({
    query,
    title: r.title,
    link: r.link,
    content: r.content,
    publish_date: r.publish_date
  }));
}

async function zhipuChat(prompt) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2
    })
  });
  if (!res.ok) {
    throw new Error(`GLM chat error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function buildPrompt(existingProjects, searchHits) {
  const existingSummary = existingProjects.map(p => ({
    id: p.id,
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
  for (const q of SEARCH_QUERIES) {
    const hits = await zhipuWebSearch(q);
    console.log(`  "${q}" -> ${hits.length} results`);
    searchHits = searchHits.concat(hits);
  }

  // De-duplicate by link
  const seen = new Set();
  searchHits = searchHits.filter(h => {
    if (!h.link || seen.has(h.link)) return false;
    seen.add(h.link);
    return true;
  });

  console.log(`Collected ${searchHits.length} unique search results. Calling GLM to extract...`);
  const raw2 = await zhipuChat(buildPrompt(projects, searchHits));
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

  let nextId = projects.reduce((max, p) => Math.max(max, p.id || 0), 0) + 1;
  for (const item of newItems) {
    if (!item.sourceUrl || !validLinks.has(item.sourceUrl)) {
      console.warn("Skipping new item with missing/unverified sourceUrl:", item.projectName);
      continue;
    }
    item.id = nextId++;
    item.sample = false;
    item.verified = true;
    projects.push(item);
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
