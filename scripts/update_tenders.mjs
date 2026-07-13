#!/usr/bin/env node
/**
 * update_tenders.mjs
 *
 * Calls the Anthropic API (with the web_search tool) to:
 *   1. Re-check the status of existing non-closed entries in data.json
 *   2. Search for genuinely new, currently-open textbook/workbook/teacher's-guide
 *      printing tenders on UNGM, UNICEF, World Bank, ADB, and peer platforms
 *   3. Merge verified results into data.json (never fabricates — if Claude can't
 *      verify something with a real source link, it's left out)
 *
 * Run manually:   ANTHROPIC_API_KEY=sk-ant-... node scripts/update_tenders.mjs
 * Run on schedule: see .github/workflows/update-tenders.yml
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "data.json");

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY environment variable.");
  process.exit(1);
}

const PLATFORMS = [
  "UNGM", "UNICEF Supply Division", "World Bank", "ADB", "AfDB", "IsDB", "IDB",
  "UNESCO", "UNHCR", "UNRWA", "UNDP", "UNOPS", "GPE (Global Partnership for Education)",
  "ECW (Education Cannot Wait)", "EU Funding & Tenders / TED", "USAID", "FCDO / UK Aid",
  "DevelopmentAid", "Devex", "dgMarket"
];

const SCHEMA_NOTE = `
Each project object MUST use this exact shape (omit a key entirely rather than guessing a value you can't verify):
{
  "id": number,                 // leave blank/omit for new items, script will assign
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
  "bidMethod": {"zh": string, "en": string},
  "submissionContact": string,
  "registrationRequired": {"zh": string, "en": string},
  "intlSuppliersAllowed": {"zh": string, "en": string},
  "locallyRestricted": {"zh": string, "en": string},
  "jvAllowed": {"zh": string, "en": string},
  "currency": string,
  "deliveryTerms": string,
  "deliveryLocation": string,
  "deliveryLeadTime": {"zh": string, "en": string},
  "paymentTerms": {"zh": string, "en": string},
  "sampleRequired": {"zh": string, "en": string},
  "qualifications": {"zh": string, "en": string},
  "pastPerformance": {"zh": string, "en": string},
  "bondRequirement": {"zh": string, "en": string},
  "customsResponsibility": {"zh": string, "en": string},
  "attachment": {"zh": string, "en": string},
  "sourceUrl": string,          // REQUIRED — a real URL returned by web_search/web_fetch
  "keyContact": string,
  "openQuestions": {"zh": string, "en": string},
  "grade": "A" | "B" | "C" | "D",
  "gradeLabel": {"zh": string, "en": string},
  "nextAction": {"zh": string, "en": string},
  "owner": string,
  "status": {"zh": string, "en": string},
  "latestUpdate": {"zh": string, "en": string},
  "notes": {"zh": string, "en": string}
}`;

async function callClaude(existingProjects) {
  const existingSummary = existingProjects.map(p => ({
    id: p.id,
    sourcePlatform: p.sourcePlatform,
    projectName: p.projectName,
    projectNo: p.projectNo,
    status: p.status,
    deadlineBeijing: p.deadlineBeijing,
    sourceUrl: p.sourceUrl || null
  }));

  const prompt = `You are refreshing a live tender-monitoring dashboard for a printing company that
prints textbooks, workbooks, and teacher's guides for international buyers (UNICEF, World Bank,
UNGM, ADB, and similar). Today's date is ${new Date().toISOString().slice(0, 10)}.

STRICT RULES:
- Only include a tender if you found it via web_search/web_fetch and can cite a real, working source URL.
- NEVER invent a project, deadline, reference number, or contact. If you are not sure, omit the field or omit the whole entry.
- Prefer the platforms: ${PLATFORMS.join(", ")}.
- For existing entries below, do a quick check (by revisiting sourceUrl if given, or a fresh search on the
  project name/reference) to see if the status or deadline has changed. Only report a change you can verify.
- Grade A = clearly open, international suppliers allowed, worth acting on today.
  Grade B = open but needs a clarifying email (eligibility, local-only ambiguity, etc).
  Grade C = open but low priority / long runway.
  Grade D = closed, expired, or disqualifying restriction (e.g. local suppliers only).

Existing entries (JSON, for status-check context only):
${JSON.stringify(existingSummary, null, 2)}

${SCHEMA_NOTE}

Return ONLY a JSON object with this shape, no prose, no markdown fences:
{
  "updates": [ { "id": <existing id>, ...only the fields that changed... } ],
  "new": [ <full project objects for genuinely new, verified tenders you found> ]
}
If you find nothing new or nothing changed, return {"updates": [], "new": []}.`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 8000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }]
    })
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const textBlocks = data.content.filter(b => b.type === "text").map(b => b.text);
  const combined = textBlocks.join("\n").trim();
  const cleaned = combined.replace(/^```json\s*/i, "").replace(/```$/, "").trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("No JSON object found in model output. Raw output:\n", combined);
    return { updates: [], new: [] };
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn("Failed to parse model JSON:", e.message);
    return { updates: [], new: [] };
  }
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

  console.log(`Loaded ${projects.length} existing projects. Calling Claude...`);
  const { updates = [], new: newItems = [] } = await callClaude(projects);

  let changed = false;

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
    if (!item.sourceUrl) {
      console.warn("Skipping new item without sourceUrl:", item.projectName);
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
