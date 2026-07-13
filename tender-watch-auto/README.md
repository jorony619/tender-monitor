# 国际教材印刷项目监控台 · 自动更新版

这是一个会**真正自动更新**的招标监控网页。它由三部分组成：

- `index.html` — 监控看板页面（打开后会先尝试读取 `data.json`，读不到时退回页面里内置的备份数据，所以离线打开也能看）
- `data.json` — 招标数据，会被下面的脚本自动改写
- `scripts/update_tenders.mjs` — 调用 Claude API（带联网搜索）去核实旧项目状态、搜索新招标，只录入能给出真实来源链接的项目，绝不编造
- `.github/workflows/update-tenders.yml` — 定时任务，每天调用一次上面的脚本，并把结果发布成网页

## 为什么需要这几个文件（诚实说明）

UNGM / UNICEF / World Bank 这些招标网站都是需要登录或 JS 渲染的动态系统，没有公开接口，
**静态网页本身没有办法在后台 24 小时自己去抓取它们**，我（Claude）也不能在对话之外持续运行。
能做到"自动更新"的唯一可靠方式，是让一段真正会按计划运行的程序（这里用 GitHub Actions 的定时任务）
去调用 Claude API 帮你搜索、核实、写回数据文件，然后你打开的网页每次都读取最新的数据文件。
这是目前技术上诚实可行的自动化方案。

## 部署步骤（约10分钟，一次性）

1. **新建一个 GitHub 仓库**（公开或私有均可），把这个文件夹的全部内容上传上去。
2. **申请一个 Anthropic API Key**：https://console.anthropic.com/ → Settings → API Keys。
   注意：这会产生真实的 API 调用费用（每天一次搜索+更新，成本很低，但请留意用量）。
3. 在仓库里点 **Settings → Secrets and variables → Actions → New repository secret**，
   新增一个名为 `ANTHROPIC_API_KEY` 的 secret，值填你的 API Key。
4. 在 **Settings → Pages**，Source 选择 "GitHub Actions"，用来把 `index.html` 发布成一个网址。
5. 到 **Actions** 标签页，找到 "Update tender data" workflow，点 **Run workflow** 手动跑一次，
   确认能成功搜索并更新 `data.json`（可以点进去看日志）。
6. 之后它会按 `.github/workflows/update-tenders.yml` 里设置的时间（默认每天北京时间9点）自动运行，
   把新发现的、真实可核实的招标写入 `data.json`，并重新发布网页。

## 想改成更即时/更频繁怎么办？

打开 `.github/workflows/update-tenders.yml`，修改这一行的 cron 表达式：

```yaml
- cron: "0 1 * * *"   # 分 时 日 月 星期，这里是每天 UTC 1点（北京9点）
```

比如改成 `"0 */6 * * *"` 就是每6小时跑一次。请不要设得过于频繁——每次运行都会调用 Claude API 并产生费用，
而且招标网站更新频率本身也没那么快。

## 本地手动运行一次

```bash
cd tender-watch-auto
ANTHROPIC_API_KEY=sk-ant-xxxx node scripts/update_tenders.mjs
```

## 如果你不想搭建 GitHub 仓库

最简单的替代方案：直接在这个对话里让我（Claude）重新搜索，我会把找到的、能核实来源的招标
更新进 `tender_watch.html`，你重新下载即可——只是这样需要你手动来问一次，不是后台自动运行。

## 数据字段说明

`data.json` 中每个招标项目包含约40个字段（平台、机构、国家、截止时间、投标方式、资质要求、
清关责任等），中英文均有对应字段，网页右上角可一键切换语言。字段命名与你原始 Excel
跟踪表（国际平台教材印刷项目跟踪表）保持一致，方便对照。
