// 手动发一条测试微信消息，用来确认 Secret 配好了。由工作流的 "test_notify" 选项触发。
import { sendWechat, pickChannel } from "./notify.mjs";

async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...options, signal: c.signal }); } finally { clearTimeout(t); }
}

const channel = pickChannel();
if (!channel) {
  console.error("::error::没有检测到任何微信渠道密钥（SERVERCHAN_KEY / PUSHPLUS_TOKEN / WECOM_WEBHOOK）。请到 Settings → Secrets and variables → Actions 添加其中一个。");
  process.exit(1);
}
console.log(`Using channel: ${channel}`);
const r = await sendWechat({
  fetchWithTimeout,
  items: [{
    grade: "B", projectName: "【测试消息】招标监控微信通知已配置成功",
    issuer: "tender-monitor", country: { zh: "测试" }, deadlineBeijing: "—",
    sourceUrl: "https://github.com/jorony619/tender-monitor"
  }],
  dashboardUrl: "https://jorony619.github.io/tender-monitor/"
});
if (!r.sent) {
  console.error(`::error::测试消息发送失败：${r.error || "未知原因"}`);
  process.exit(1);
}
console.log("Test message sent. Check WeChat.");
