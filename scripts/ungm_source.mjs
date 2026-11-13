/**
 * ungm_source.mjs — UNGM（联合国全球采购平台）公开公告直接抓取
 *
 * UNGM 的公开公告 (https://www.ungm.org/Public/Notice) 不需要登录就能搜索、查看，
 * 所以这里完全不使用任何账号密码。流程：
 *   1. GET /Public/Notice 拿 cookie（以及页面里的防伪 token，如果有）
 *   2. 对每个关键词 POST /Public/Notice/Search（和网页"搜索"按钮发的是同一个请求），
 *      返回的是 HTML 片段，每行一条公告，带 data-noticeid
 *   3. 按"文字内容"解析（日期格式 / 公告类型词），而不是依赖 class 名，页面小改版也能扛
 *
 * 重要：写这个模块时无法从开发环境访问 ungm.org，所以请求格式和页面结构是按已知的
 * 网页行为写的，未经真实站点验证。因此它被设计成：
 *   - 永远不抛异常，返回 { items, listed, error }
 *   - 解析到 0 条 / 请求失败 → error 非空 → 主脚本把本次标记为 degraded，并在看板顶部提示
 *   - 解析不到行时把响应开头打到日志里，方便一次定位问题
 */

import { isRelevant, EDU_RE } from "./osce_source.mjs";

export const UNGM_BASE = "https://www.ungm.org";
const UA = "Mozilla/5.0 (compatible; tender-monitor/1.0; +https://github.com/jorony619/tender-monitor)";
const PAGE_SIZE = 15;
const MAX_PAGES_PER_KEYWORD = 2;

// 每个关键词查 UNGM 标题；UNGM 的 Title 过滤是子串/词匹配
export const UNGM_KEYWORDS = [
  "textbook",
  "printing of books",
  "printing services",
  "printing and delivery",
  "workbook",
  "exercise book",
  "learning materials",
  "reading materials",
  "printing of"
];

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------
function decodeEntities(s) {
  return String(s)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function toLines(html) {
  const text = decodeEntities(
    String(html)
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(?:div|p|li|ul|ol|h[1-6]|tr|td|th|span|dt|dd|label|a|time|section)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
  return text.split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// UNGM 日期：「23-Nov-2026 14:00 (GMT 5.00)」或「23-Nov-2026」
const DATE_RE = /(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{4})(?:\s+(\d{1,2}):(\d{2}))?(?:\s*\(\s*GMT\s*([+-]?\d+(?:\.\d+)?)?\s*\))?/;
const DATE_RE_G = new RegExp(DATE_RE.source, "g");

/** 解析一个 UNGM 日期字符串 → { ymd, utcMs, hasTime, raw } | null */
export function parseUngmDate(s) {
  const m = String(s || "").match(DATE_RE);
  if (!m) return null;
  const mo = MON[m[2].toLowerCase()];
  if (!mo) return null;
  const y = +m[3], d = +m[1];
  const hasTime = m[4] !== undefined;
  const h = hasTime ? +m[4] : 23, mi = hasTime ? +m[5] : 59;
  const gmt = m[6] !== undefined ? parseFloat(m[6]) : 0; // 没写时区按 GMT
  const utcMs = Date.UTC(y, mo - 1, d, h, mi) - gmt * 3600 * 1000;
  return { ymd: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, utcMs, hasTime, raw: m[0].trim() };
}

function fmtBeijing(utcMs) {
  return new Date(utcMs + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

// ---------------------------------------------------------------------------
// 列表解析
// ---------------------------------------------------------------------------
const TYPE_RE = /request for (?:quotation|proposal|information|expression of interest)|invitation to (?:bid|tender|participate|pre-?qualif\w*)|request for (?:eoi|rfq|rfp)|expression of interest|call for (?:proposal|tender)s?|grant support|pre-?qualification|tender notice|contract award|award notice|notice of award|\b(?:rfq|rfp|itb|eoi|ifb)\b|prior information|framework agreement|long[- ]term agreement/i;
const AWARD_RE = /award/i;

/**
 * 把列表 HTML 解析成 [{id, href, title, publishedRaw, deadlineRaw, agency, noticeType, reference, country}]
 * 以 data-noticeid 切块；没有 data-noticeid 时退回到 /Public/Notice/<数字> 链接切块。
 */
export function parseUngmListing(html) {
  const src = String(html || "");
  const marks = [];
  let m;
  const idRe = /data-noticeid\s*=\s*["']?(\d+)/gi;
  while ((m = idRe.exec(src))) marks.push({ id: m[1], idx: m.index });
  if (!marks.length) {
    const linkRe = /href\s*=\s*["'](?:https?:\/\/www\.ungm\.org)?\/Public\/Notice\/(\d+)[^"']*["']/gi;
    const seen = new Set();
    while ((m = linkRe.exec(src))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      marks.push({ id: m[1], idx: m.index });
    }
  }
  const rows = [];
  for (let i = 0; i < marks.length; i++) {
    const chunk = src.slice(marks[i].idx, i + 1 < marks.length ? marks[i + 1].idx : src.length);
    const row = parseRowChunk(marks[i].id, chunk);
    if (row) rows.push(row);
  }
  // 同一 id 去重
  const byId = new Map();
  for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  return [...byId.values()];
}

function parseRowChunk(id, chunk) {
  // 标题优先取指向详情页的链接的 title / 文本
  let title = "";
  const a = chunk.match(/<a\b[^>]*href\s*=\s*["'][^"']*\/Public\/Notice\/\d+[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
  if (a) title = toLines(a[1]).join(" ").trim();
  if (!title) {
    const t = chunk.match(/\btitle\s*=\s*["']([^"']{8,})["']/i);
    if (t) title = decodeEntities(t[1]).trim();
  }

  const lines = toLines(chunk);
  if (!title) title = lines.find(l => !DATE_RE.test(l) && l.length > 6) || "";
  if (!title) return null;

  // 日期：行内所有日期按值排序，较早为发布日、较晚为截止日（和列顺序无关）
  const dates = [];
  for (const l of lines) {
    DATE_RE_G.lastIndex = 0;
    let dm;
    while ((dm = DATE_RE_G.exec(l))) {
      const p = parseUngmDate(dm[0]);
      if (p) dates.push(p);
    }
  }
  let published = null, deadline = null;
  if (dates.length === 1) deadline = dates[0];
  else if (dates.length >= 2) {
    const sorted = [...dates].sort((x, y) => x.utcMs - y.utcMs);
    published = sorted[0];
    deadline = sorted[sorted.length - 1];
  }

  // 公告类型行 → 机构 = 它的上一行；编号 = 下一行；国家 = 再下一行
  let noticeType = "", agency = "", reference = "", country = "";
  const typeIdx = lines.findIndex((l, i) => i > 0 && l !== title && !DATE_RE.test(l) && l.length < 80 && TYPE_RE.test(l));
  if (typeIdx > 0) {
    noticeType = lines[typeIdx];
    const prev = lines[typeIdx - 1];
    if (prev && prev !== title && !DATE_RE.test(prev)) agency = prev;
    const next = lines[typeIdx + 1];
    if (next && !DATE_RE.test(next)) reference = next;
    const next2 = lines[typeIdx + 2];
    if (next2 && !DATE_RE.test(next2)) country = next2;
  }

  return {
    id,
    href: `/Public/Notice/${id}`,
    title,
    publishedRaw: published ? published.raw : "",
    deadlineRaw: deadline ? deadline.raw : "",
    published, deadline,
    agency, noticeType, reference, country
  };
}

// ---------------------------------------------------------------------------
// 行 → data.json 项目
// ---------------------------------------------------------------------------
export function ungmToProject(row, todayYmd) {
  const url = UNGM_BASE + row.href;
  const dl = row.deadline;
  const isOpen = dl ? dl.ymd >= todayYmd : true;
  const isEdu = EDU_RE.test(row.title);

  let grade, gradeLabel;
  if (!isOpen) {
    grade = "D"; gradeLabel = { zh: "D-已错过/归档", en: "D — Missed / archived" };
  } else if (isEdu) {
    grade = "B"; gradeLabel = { zh: "B-发邮件确认", en: "B — Confirm by email" };
  } else {
    grade = "C"; gradeLabel = { zh: "C-非教材类印刷，低优先级", en: "C — Non-textbook printing, low priority" };
  }

  const agency = row.agency || "UN agency";
  return {
    sample: false,
    verified: true,
    region: "international",
    discoveryDate: todayYmd,
    sourcePlatform: "UNGM 联合国全球采购平台 / UNGM (ungm.org)",
    issuer: agency,
    country: { zh: row.country || "", en: row.country || "" },
    projectName: row.title,
    projectNo: row.reference || "",
    projectType: isEdu
      ? { zh: "教材/出版物印刷", en: "Textbook / publication printing" }
      : { zh: "印刷服务（非教材类）", en: "Printing service (non-textbook)" },
    summary: {
      zh: `${agency} 在 UNGM 发布的${row.noticeType ? `「${row.noticeType}」` : "公告"}：${row.title}`,
      en: `${row.noticeType || "Notice"} published by ${agency} on UNGM: ${row.title}`
    },
    fundingSource: agency,
    publishDate: row.published ? row.published.ymd : undefined,
    deadlineLocal: row.deadlineRaw || undefined,
    deadlineBeijing: dl ? (dl.hasTime ? fmtBeijing(dl.utcMs) : `${dl.ymd} 23:59`) : undefined,
    sourceUrl: url,
    grade,
    gradeLabel,
    nextAction: isOpen
      ? {
          zh: "打开公告页（UNGM 公开可看；下载招标文件通常需要免费注册），核对资格要求、交期、贸易术语与是否限当地供应商，再按公告联系方式发澄清问题。",
          en: "Open the notice page (public on UNGM; downloading the documents usually needs a free registration), check eligibility, delivery date, Incoterms and any local-supplier restriction, then send clarification questions to the contact in the notice."
        }
      : { zh: "已过截止日期，仅作该机构采购节奏参考。", en: "Past deadline; kept only as a reference for this agency's procurement cadence." },
    status: isOpen
      ? { zh: "新发现", en: "Newly discovered" }
      : { zh: "已过期", en: "Expired" },
    notes: {
      zh: "来自 UNGM 公开公告搜索（直接抓取，未经AI改写；无需登录）。字段按列表页解析，详细要求、是否允许外国供应商以招标文件为准。",
      en: "Taken directly from UNGM's public notice search (not web search, not AI-rewritten; no login used). Fields are parsed from the result list; eligibility and whether foreign suppliers may bid are set by the bidding documents."
    }
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
function searchBody(keyword, pageIndex) {
  return {
    PageIndex: pageIndex,
    PageSize: PAGE_SIZE,
    Title: keyword,
    Description: "",
    Reference: "",
    PublishedFrom: "",
    PublishedTo: "",
    DeadlineFrom: "",
    DeadlineTo: "",
    Countries: [],
    Agencies: [],
    UNSPSCs: [],
    NoticeTypes: [],
    SortField: "DatePublished",
    SortAscending: false,
    isPicker: false,
    IsSustainable: false,
    IsActive: true,
    NoticeDisplayType: null,
    NoticeSearchTotalLabelId: "noticeSearchTotal",
    TypeOfCompetitions: []
  };
}

/**
 * @param {object} opts
 * @param {(url:string, options?:object, timeoutMs?:number)=>Promise<Response>} opts.fetchWithTimeout
 * @param {string} [opts.today] YYYY-MM-DD（测试注入用）
 * @param {string[]} [opts.keywords]
 */
export async function fetchUngmCandidates({ fetchWithTimeout, today, keywords = UNGM_KEYWORDS, logger = console } = {}) {
  const todayYmd = today || new Date().toISOString().slice(0, 10);
  logger.log("Fetching UNGM public notices (no login)...");

  let cookie = "";
  let token = "";
  try {
    const res = await fetchWithTimeout(`${UNGM_BASE}/Public/Notice`, { headers: { "User-Agent": UA, Accept: "text/html" } }, 30000);
    if (!res.ok) throw new Error(`${res.status} /Public/Notice`);
    const sc = typeof res.headers?.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    cookie = sc.map(c => c.split(";")[0]).join("; ");
    const html = await res.text();
    const tk = html.match(/name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i)
      || html.match(/value=["']([^"']+)["'][^>]*name=["']__RequestVerificationToken["']/i);
    if (tk) token = tk[1];
  } catch (e) {
    const error = `UNGM page fetch failed: ${String(e.message || e).slice(0, 200)}`;
    logger.warn(`  ${error}`);
    return { items: [], listed: 0, error };
  }

  const rowsById = new Map();
  let requests = 0, failures = 0, lastError = null, firstEmptySample = null;
  for (const kw of keywords) {
    for (let page = 0; page < MAX_PAGES_PER_KEYWORD; page++) {
      requests++;
      let html;
      try {
        const res = await fetchWithTimeout(`${UNGM_BASE}/Public/Notice/Search`, {
          method: "POST",
          headers: {
            "User-Agent": UA,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest",
            Accept: "text/html, */*; q=0.01",
            Referer: `${UNGM_BASE}/Public/Notice`,
            ...(cookie ? { Cookie: cookie } : {}),
            ...(token ? { RequestVerificationToken: token, "X-CSRF-TOKEN": token } : {})
          },
          body: JSON.stringify(searchBody(kw, page))
        }, 30000);
        if (!res.ok) throw new Error(`${res.status} POST /Public/Notice/Search`);
        html = await res.text();
      } catch (e) {
        failures++;
        lastError = `UNGM search failed: ${String(e.message || e).slice(0, 200)}`;
        logger.warn(`  [${kw}] ${lastError}`);
        break;
      }
      const rows = parseUngmListing(html);
      if (!rows.length) {
        if (!firstEmptySample) firstEmptySample = String(html).replace(/\s+/g, " ").slice(0, 300);
        break;
      }
      let added = 0;
      for (const r of rows) if (!rowsById.has(r.id)) { rowsById.set(r.id, r); added++; }
      if (rows.length < PAGE_SIZE || !added) break; // 最后一页
    }
  }

  const rows = [...rowsById.values()];
  logger.log(`  UNGM: ${rows.length} notice(s) parsed from ${requests} request(s) (${failures} failed).`);

  let error = null;
  if (failures === requests) error = lastError || "UNGM: all search requests failed";
  else if (!rows.length) {
    error = "UNGM search parsed 0 notices (request format or page structure may have changed)";
    logger.warn(`  ${error}. Response starts with: ${firstEmptySample || "(empty)"}`);
  }

  const relevant = rows.filter(r => isRelevant(r.title) && !(AWARD_RE.test(r.noticeType)));
  logger.log(`  ${relevant.length} match printing/publication keywords (award notices excluded).`);
  const items = relevant.map(r => ungmToProject(r, todayYmd));
  return { items, listed: rows.length, error };
}
