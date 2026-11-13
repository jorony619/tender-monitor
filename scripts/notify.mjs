/**
 * notify.mjs — 运行后微信通知（Server酱 / PushPlus / 企业微信群机器人，三选一）
 *
 * 哪个密钥配了就用哪个（按下面顺序，只发一个渠道）：
 *   SERVERCHAN_KEY   Server酱 Turbo 的 SendKey（sct.ftqq.com）
 *   PUSHPLUS_TOKEN   PushPlus 的 token（pushplus.plus）
 *   WECOM_WEBHOOK    企业微信群机器人的完整 Webhook 地址
 * 一个都没配 → 静默跳过。发送失败只打日志，绝不让整个运行失败。
 */

const MAX_ITEMS_IN_MESSAGE = 8;

export function pickChannel(env = process.env) {
  if (env.SERVERCHAN_KEY) return "serverchan";
  if (env.PUSHPLUS_TOKEN) return "pushplus";
  if (env.WECOM_WEBHOOK) return "wecom";
  return null;
}

/** 把新增项目整理成 {title, body}（纯文本/markdown，三个渠道都能显示） */
export function buildMessage(items, { dashboardUrl = "", health = null } = {}) {
  const n = items.length;
  const title = `新增 ${n} 个教材印刷招标项目`;
  const lines = [];
  for (const p of items.slice(0, MAX_ITEMS_IN_MESSAGE)) {
    const grade = p.grade ? `[${p.grade}] ` : "";
    lines.push(`${grade}${p.projectName}`);
    const meta = [
      p.issuer,
      p.country && (p.country.zh || p.country.en),
      p.deadlineBeijing ? `截止(北京时间) ${p.deadlineBeijing}` : null
    ].filter(Boolean).join(" | ");
    if (meta) lines.push(`  ${meta}`);
    if (p.sourceUrl) lines.push(`  ${p.sourceUrl}`);
    lines.push("");
  }
  if (n > MAX_ITEMS_IN_MESSAGE) lines.push(`…另有 ${n - MAX_ITEMS_IN_MESSAGE} 个，请打开看板查看。`, "");
  if (health && health.status && health.status !== "ok" && health.message && health.message.zh) {
    lines.push(`⚠ 提示：${health.message.zh}`, "");
  }
  if (dashboardUrl) lines.push(`看板：${dashboardUrl}`);
  return { title, body: lines.join("\n").trim() };
}

async function postJson(fetchFn, url, payload) {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(payload)
  }, 20000);
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
  return text;
}

/**
 * @returns {Promise<{sent:boolean, channel:string|null, error?:string}>} 永不抛异常
 */
export async function sendWechat({ fetchWithTimeout, items, dashboardUrl = "", health = null, env = process.env, logger = console }) {
  const channel = pickChannel(env);
  if (!channel) {
    logger.log("Notify: no WeChat channel configured (SERVERCHAN_KEY / PUSHPLUS_TOKEN / WECOM_WEBHOOK); skipping.");
    return { sent: false, channel: null };
  }
  if (!items || !items.length) return { sent: false, channel };

  const { title, body } = buildMessage(items, { dashboardUrl, health });
  try {
    if (channel === "serverchan") {
      const key = encodeURIComponent(env.SERVERCHAN_KEY);
      const text = await postJson(fetchWithTimeout, `https://sctapi.ftqq.com/${key}.send`, { title, desp: body.replace(/\n/g, "\n\n") });
      let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
      if (j && j.code !== undefined && j.code !== 0) throw new Error(`Server酱 returned code ${j.code}: ${j.message || ""}`);
    } else if (channel === "pushplus") {
      const text = await postJson(fetchWithTimeout, "https://www.pushplus.plus/send", {
        token: env.PUSHPLUS_TOKEN, title, content: body.replace(/\n/g, "<br>"), template: "html"
      });
      let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
      if (j && j.code !== undefined && j.code !== 200) throw new Error(`PushPlus returned code ${j.code}: ${j.msg || ""}`);
    } else {
      const text = await postJson(fetchWithTimeout, env.WECOM_WEBHOOK, {
        msgtype: "text", text: { content: `${title}\n\n${body}`.slice(0, 1800) }
      });
      let j = null; try { j = JSON.parse(text); } catch { /* 非 JSON */ }
      if (j && j.errcode !== undefined && j.errcode !== 0) throw new Error(`企业微信 returned errcode ${j.errcode}: ${j.errmsg || ""}`);
    }
    logger.log(`Notify: sent ${items.length} new project(s) via ${channel}.`);
    return { sent: true, channel };
  } catch (e) {
    // 不打印完整 URL/密钥，只打印错误信息
    const msg = String(e.message || e).replace(env.SERVERCHAN_KEY || "\u0000", "***").replace(env.PUSHPLUS_TOKEN || "\u0000", "***").slice(0, 300);
    logger.warn(`Notify: sending via ${channel} failed: ${msg}`);
    return { sent: false, channel, error: msg };
  }
}
