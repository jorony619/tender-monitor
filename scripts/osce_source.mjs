/**
 * osce_source.mjs — OSCE 官方采购网站 (procurement.osce.org) 直接抓取
 *
 * 为什么单独抓：OSCE 各驻外办公室的印刷类询价 (RFQ/ITB) 只发在自己的采购网站
 * 和（部分）UNGM 上，搜索引擎覆盖不稳定；BidsInfo 之类聚合站只给摘要且需登录。
 * 列表页 https://procurement.osce.org/tenders 是公开的"当前开放招标"，每条都带
 * 标题 / 发布日期 / 发布办公室 / 截止时间，所以直接抓，不经过网页搜索、不经过 AI 改写，
 * 和世界银行官方数据集走同一个思路。
 *
 * 对外只暴露 fetchOsceCandidates()，永远不抛异常，返回
 *   { items: [project...], listed: <列表页解析到的条数>, error: <string|null> }
 * 主脚本据此合并去重，并在 listed === 0 或 error 时把本次标记为 degraded
 * （页面结构变了会第一时间在看板顶部提示，而不是悄悄"无新项目"）。
 */

export const OSCE_BASE = "https://procurement.osce.org";
const MAX_LIST_PAGES = 10;      // 列表页最多翻这么多页（目前约 3 页）
const MAX_DETAIL_FETCHES = 30;  // 每次运行最多抓这么多条详情页
const UA = "tender-monitor/1.0 (+https://github.com/jorony619/tender-monitor)";

// ---------------------------------------------------------------------------
// 相关性：标题里出现"印刷/出版/图书"等才收；再按"是否教材类"分级
// ---------------------------------------------------------------------------
const PRINT_RE = /\bprint(?:ing|ed)?\b|reprint|publication|publish|textbook|workbook|handbook|booklet|brochure|leaflet|poster|flyer|\bbooks?\b|reproduction|darslik|учебник|печат/i;
// 买打印设备/耗材不是印刷服务
const EXCLUDE_RE = /\b(?:printers?|toners?|cartridges?|copiers?|photocopiers?|consumables?)\b|printing\s+(?:equipment|machines?)|\bbanners?\b/i;
// 教材/学习材料类（对你们业务最贴近）→ B；其余印刷 → C
const EDU_RE = /textbook|workbook|teacher|learning\s+material|educational|curriculum|darslik|exercise\s+book|school|training\s+(?:material|manual)|handbook|учебник/i;

export function isRelevant(text) {
  const t = String(text || "");
  if (!PRINT_RE.test(t)) return false;
  if (EXCLUDE_RE.test(t) && !/textbook|workbook|darslik/i.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// HTML 工具（不引依赖：只用正则；对 Drupal 渲染的列表页足够，且对标签细节宽容）
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

/** HTML → 按行的纯文本（块级标签换行，行内空白折叠） */
export function htmlToLines(html) {
  const text = decodeEntities(
    String(html)
      .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(?:div|p|li|ul|ol|h[1-6]|tr|td|th|section|article|header|footer|span|dt|dd|label|a|time)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  );
  return text.split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/** "9 November 2026" → "2026-11-09" */
export function parseLongDate(s) {
  const m = String(s || "").match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// 时区：把 "23 November 2026 - 14:00 , Asia/Tashkent" 换算成北京时间
// ---------------------------------------------------------------------------
function tzOffsetMs(utcMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
  const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs;
}
export function zonedToUtcMs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ms = guess - tzOffsetMs(guess, tz);
  ms = guess - tzOffsetMs(ms, tz); // 二次修正，处理夏令时边界
  return ms;
}
function fmtBeijing(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** 返回 { local, ymd, beijing }；任何一项解析不了就是 null / 近似值 */
export function parseDeadline(raw) {
  const s = String(raw || "").trim();
  if (!s) return { local: null, ymd: null, beijing: null };
  const ymd = parseLongDate(s);
  const t = s.match(/(\d{1,2}):(\d{2})/);
  const tzm = s.match(/([A-Za-z_]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)/);
  let beijing = null;
  if (ymd && t && tzm) {
    try {
      const [y, mo, d] = ymd.split("-").map(Number);
      beijing = fmtBeijing(zonedToUtcMs(y, mo, d, +t[1], +t[2], tzm[1]));
    } catch { /* 未知时区名：退回近似值 */ }
  }
  if (!beijing && ymd) beijing = `${ymd} 23:59`; // 只知道日期：取当天末，宁可晚算不早判过期
  return { local: s.replace(/\s+,/g, ","), ymd, beijing };
}

// ---------------------------------------------------------------------------
// 办公室 → 国家/地区
// ---------------------------------------------------------------------------
const OFFICE_COUNTRY = [
  [/uzbekistan/i, "乌兹别克斯坦", "Uzbekistan"],
  [/tajikistan|dushanbe/i, "塔吉克斯坦", "Tajikistan"],
  [/kyrgyz|bishkek/i, "吉尔吉斯斯坦", "Kyrgyzstan"],
  [/kazakhstan|astana|nur-sultan/i, "哈萨克斯坦", "Kazakhstan"],
  [/ashgabat|turkmen/i, "土库曼斯坦", "Turkmenistan"],
  [/ukraine/i, "乌克兰", "Ukraine"],
  [/albania/i, "阿尔巴尼亚", "Albania"],
  [/kosovo/i, "科索沃", "Kosovo"],
  [/skopje|north macedonia/i, "北马其顿", "North Macedonia"],
  [/bosnia/i, "波黑", "Bosnia and Herzegovina"],
  [/montenegro/i, "黑山", "Montenegro"],
  [/serbia/i, "塞尔维亚", "Serbia"],
  [/moldova/i, "摩尔多瓦", "Moldova"],
  [/yerevan|armenia/i, "亚美尼亚", "Armenia"],
  [/baku|azerbaijan/i, "阿塞拜疆", "Azerbaijan"],
  [/secretariat/i, "奥地利（维也纳）/ 多国", "Austria (Vienna) / multiple"],
  [/odihr/i, "波兰（华沙）/ 多国", "Poland (Warsaw) / multiple"],
  [/democratic institutions/i, "波兰（华沙）/ 多国", "Poland (Warsaw) / multiple"]
];
function countryOf(office) {
  for (const [re, zh, en] of OFFICE_COUNTRY) if (re.test(office)) return { zh, en };
  return { zh: "", en: "" };
}

// ---------------------------------------------------------------------------
// 列表页解析
// ---------------------------------------------------------------------------
/**
 * 从列表页 HTML 里提取每条招标：
 *   { href, title, launch, office, deadlineRaw }
 * 做法：找所有指向 /tenders/<slug> 的链接（导航里的 /tenders、带 ?筛选 的链接不算），
 * 每条链接到下一条链接之间的文本就是它的卡片，再用标签词（Launch date / On behalf of /
 * Deadline）取值——不依赖具体 class 名，Drupal 主题小改也不会失效。
 */
export function parseListing(html) {
  const anchorRe = /<a\b[^>]*?href=["']([^"']*\/tenders\/[^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const hits = [];
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    hits.push({ href: m[1], inner: m[2], start: m.index, end: m.index + m[0].length });
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    let path = h.href.replace(/^https?:\/\/procurement\.osce\.org/i, "");
    if (!path.startsWith("/tenders/")) continue;
    if (seen.has(path)) continue;
    // 卡片 = 本链接之后到"下一条不同链接"之前的内容
    let nextStart = html.length;
    for (let j = i + 1; j < hits.length; j++) {
      const p2 = hits[j].href.replace(/^https?:\/\/procurement\.osce\.org/i, "");
      if (p2 !== path) { nextStart = hits[j].start; break; }
    }
    const title = htmlToLines(h.inner).join(" ").trim();
    if (!title) continue; // 图片链接等没有文字的重复入口，由同一条的文字链接负责
    seen.add(path);
    const lines = htmlToLines(html.slice(h.end, Math.min(nextStart, h.end + 4000)));
    const after = (label) => {
      const idx = lines.findIndex(l => l.toLowerCase().startsWith(label));
      if (idx < 0) return null;
      const same = lines[idx].slice(label.length).replace(/^[:\s]+/, "").trim();
      return same || lines[idx + 1] || null;
    };
    out.push({
      href: path,
      title,
      launch: parseLongDate(after("launch date")),
      office: (after("on behalf of") || "").trim(),
      deadlineRaw: after("deadline")
    });
  }
  return out;
}

/** 详情页：参考编号 / 采购方式 / 合同期限 / 需求概述 */
export function parseDetail(html) {
  const lines = htmlToLines(html);
  const val = (label) => {
    const idx = lines.findIndex(l => l.toLowerCase() === label.toLowerCase() || l.toLowerCase().startsWith(label.toLowerCase() + " "));
    if (idx < 0) return null;
    const same = lines[idx].slice(label.length).trim();
    return same || lines[idx + 1] || null;
  };
  let summary = null;
  const si = lines.findIndex(l => /^summary of requirements$/i.test(l));
  if (si >= 0) {
    const buf = [];
    for (let k = si + 1; k < lines.length; k++) {
      if (/^(download bidding documents|footer|home)$/i.test(lines[k])) break;
      buf.push(lines[k]);
    }
    summary = buf.join(" ").slice(0, 800) || null;
  }
  return {
    ref: val("Reference Number"),
    procedure: val("Procurement procedures"),
    duration: val("Expected contract duration"),
    summary
  };
}

// ---------------------------------------------------------------------------
// 转成 data.json 的项目对象
// ---------------------------------------------------------------------------
export function osceToProject(card, detail, todayYmd) {
  const url = OSCE_BASE + card.href;
  const dl = parseDeadline(card.deadlineRaw);
  const isOpen = dl.ymd ? dl.ymd >= todayYmd : true;
  const isEdu = EDU_RE.test(`${card.title} ${(detail && detail.summary) || ""}`);

  // 询价通常要求注册企业 + 相关经验 + 当地许可/ISBN 等，不能默认允许外国供应商 → 最高 B
  let grade, gradeLabel;
  if (!isOpen) {
    grade = "D"; gradeLabel = { zh: "D-已错过/归档", en: "D — Missed / archived" };
  } else if (isEdu) {
    grade = "B"; gradeLabel = { zh: "B-发邮件确认", en: "B — Confirm by email" };
  } else {
    grade = "C"; gradeLabel = { zh: "C-非教材类印刷，低优先级", en: "C — Non-textbook printing, low priority" };
  }

  const office = card.office || "";
  const issuerShort = office.replace(/^OSCE\s+/i, "");
  const country = countryOf(office);
  const summaryText = (detail && detail.summary) || card.title;
  const procedure = (detail && detail.procedure) || "";

  return {
    sample: false,
    verified: true,
    region: "international",
    discoveryDate: todayYmd,
    sourcePlatform: "OSCE 官方采购网站 / OSCE Procurement portal (procurement.osce.org)",
    issuer: issuerShort ? `OSCE – ${issuerShort}` : "OSCE",
    country,
    projectName: card.title,
    projectNo: (detail && detail.ref) || "",
    projectType: isEdu
      ? { zh: "教材/出版物印刷", en: "Textbook / publication printing" }
      : { zh: "印刷服务（非教材类）", en: "Printing service (non-textbook)" },
    summary: { zh: summaryText, en: summaryText },
    fundingSource: "OSCE",
    publishDate: card.launch || undefined,
    deadlineLocal: dl.local || undefined,
    deadlineBeijing: dl.beijing || undefined,
    sourceUrl: url,
    grade,
    gradeLabel,
    nextAction: isOpen
      ? {
          zh: "在公告页免费下载招标文件（需填公司/联系人信息），核对资格要求、交期、贸易术语与是否限当地供应商，再按公告邮箱发澄清问题。",
          en: "Download the bidding documents from the notice page (free; company/contact form required), check eligibility, delivery date, Incoterms and any local-supplier requirement, then email the procurement address with clarification questions."
        }
      : { zh: "已过截止日期，仅作该办公室采购节奏参考。", en: "Past deadline; kept only as a reference for this office's procurement cadence." },
    status: isOpen
      ? { zh: "新发现", en: "Newly discovered" }
      : { zh: "已过期", en: "Expired" },
    notes: {
      zh: `来自 OSCE 官方采购网站公开列表（直接抓取，未经AI改写）。${procedure ? `采购方式：${procedure}。` : ""}资格要求（注册证书、相关经验年限、当地许可/ISBN 等）以招标文件为准，不应默认允许外国供应商；通常只接受邮件提交。`,
      en: `Taken directly from the public OSCE procurement portal listing (not web search, not AI-rewritten). ${procedure ? `Procedure: ${procedure}. ` : ""}Eligibility (registration certificate, years of experience, local licence/ISBN, etc.) is set by the bidding documents — do not assume foreign suppliers are allowed; submissions are normally by email only.`
    }
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
/**
 * @param {object} opts
 * @param {(url:string, options?:object, timeoutMs?:number)=>Promise<Response>} opts.fetchWithTimeout
 * @param {string} [opts.today] YYYY-MM-DD（测试注入用）
 * @param {{log:Function,warn:Function}} [opts.logger]
 */
export async function fetchOsceCandidates({ fetchWithTimeout, today, logger = console } = {}) {
  const todayYmd = today || new Date().toISOString().slice(0, 10);
  const headers = { "User-Agent": UA, Accept: "text/html" };
  const getText = async (url) => {
    const res = await fetchWithTimeout(url, { headers }, 30000);
    if (!res.ok) {
      const err = new Error(`${res.status} ${url}`);
      err.status = res.status;
      throw err;
    }
    return res.text();
  };

  logger.log("Fetching OSCE procurement portal open tenders...");
  const cards = [];
  const seenHref = new Set();
  let error = null;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    let html;
    try {
      html = await getText(`${OSCE_BASE}/tenders?page=${page}`);
    } catch (e) {
      // 翻过最后一页时站点可能回 404：第 1 页之后的 404 只当"没有更多页"。
      if (page > 0 && e.status === 404) break;
      error = `OSCE listing fetch failed: ${String(e.message || e).slice(0, 200)}`;
      logger.warn(`  ${error}`);
      break; // 已抓到的前几页仍然保留并使用，只是本次会被标记为 degraded
    }
    const pageCards = parseListing(html).filter(c => !seenHref.has(c.href));
    if (!pageCards.length) break; // 翻到头了（或页面没有新条目）
    pageCards.forEach(c => { seenHref.add(c.href); cards.push(c); });
  }
  logger.log(`  OSCE listing: ${cards.length} open tender(s) parsed.`);
  if (!cards.length && !error) {
    error = "OSCE listing parsed 0 tenders (page structure may have changed)";
    logger.warn(`  ${error}`);
  }

  const relevant = cards.filter(c => isRelevant(c.title));
  logger.log(`  ${relevant.length} match printing/publication keywords.`);

  const items = [];
  let detailCount = 0;
  for (const c of relevant) {
    let detail = null;
    if (detailCount < MAX_DETAIL_FETCHES) {
      detailCount++;
      try {
        detail = parseDetail(await getText(OSCE_BASE + c.href));
      } catch (e) {
        logger.warn(`  OSCE detail fetch failed for ${c.href}: ${String(e.message || e).slice(0, 120)} (using listing data only)`);
      }
    }
    items.push(osceToProject(c, detail, todayYmd));
  }
  return { items, listed: cards.length, error };
}
