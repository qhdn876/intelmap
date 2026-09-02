# intelmap

个人用全球态势看板。**16 个免密钥数据源、零运行时依赖、零 AI、延迟透明。**
单进程 `node src/server.mjs` 起服务，`npm start` 到打开页面之间不需要任何安装步骤。

写它的直接原因是我想把 [koala73/worldmonitor](https://github.com/koala73/worldmonitor) 变成"个人版"，读完代码后发现：**要删掉的东西比要留的多，那就重写一个更快。**

本文第 1 节是对那个项目的具体评价。所有数字都在 2026-09-02 快照下由脚本抓取，脚本在本仓库里，你可以重跑（见 §9）。

---

## 1. 关于 koala73/worldmonitor：我实测到了什么

先说清楚立场：**它是一个真实的、能用的、覆盖面惊人的产品。** 我没有发现任何"假数据"或"骗人"的证据，下面的批评全部关于**错配**，不是关于欺诈。

### 1.1 它好的地方（免得被理解成黑）

- 界面确实是专业的。地图分层、面板密度、多主题变体，一看就是有人真在用。
- 工程面不是假的：`src/` 894 个文件、**2,029 个测试文件**、313 个 `.proto`、**42 个 CI workflow**、`typecheck` 与 security-audit 都在跑。我抽样读了 `src/services/analysis-core.mjs`，注释里写着"本模块函数全部为纯函数，聚类逻辑已移到 shared/ 以便服务端与客户端一致（#5697）"——这是有意识的架构决策。
- MCP server 是真的活着：我实测 `tools/list` 免密钥返回 **74 个工具**，`tools/call` 才要 key。
- 数据源覆盖面（冲突/航运/航空/海底电缆/空气/能源/市场）在同类产品里确实算全。

### 1.2 问题一：对个人使用者，它的复杂度是净负担

| 指标 | 实测 |
|---|---|
| 仓库 git 体积 | **202 MB**（`size: 206585KB`），7 分钟内 clone 完是种煎熬 |
| 文件数 | 6,614（其中 `docs/` 668 个 / 23.5MB，`blog-site/` 234 个 / 13.4MB） |
| `.env.example` 键数 | **272 个** |
| `package.json` scripts | **171 条** |
| 线上 OpenAPI | **2.8 MB / 228 个路径** |
| 运行时后端 | Vercel Edge + Railway + Upstash + Convex + Clerk + Dodo Payments |

README 说 "The app runs with no environment variables" —— 这句是真的，但**它指的是空壳能启动**。你打开会看到大量面板是空的：ACLED、UCDP、Finnhub、EIA、FRED、IMF、USDA、Wingbits、aviationstack、WAQI、OpenAQ、ICAO、Cloudflare R2 都需要你自己的 key。README 没撒谎，但它把一个**需要十几个付费/注册账号才能填满的仪表盘**描述成了"零配置可跑"。

### 1.3 问题二：AI 层是产品需要，不是情报需要

它有：LLM 新闻合成简报、24h/7d/30d 预测、CII 国家不稳定指数 v8、跨流信号关联、AI 分析师对话（Pro $39.99/月）。

问题是这些**恰好是最不该外包给模型的部分**。一个把 GDELT 事件聚合成"局势简报"的功能，实质是把可验证的原始事实压成不可验证的自然语言；出错了你无法追溯，因为它不给置信度也不给反证。

有意思的是，作者自己也清楚——它仓库里就有这些 issue：
- `feat(forecast): empirical recalibration layer fitted on the published-origin resolved outcomes`
- `feat(scorecard): honesty markers — valid uncertainty, auditable corpus, replay-gated`
- `epic(news): make digest retention bounded, category-complete, and honest`

**"honesty markers" 需要被打进 TODO，说明当前版本没有。** 而同期 README 把桌面端和站点标为 `Stable`。

### 1.4 问题三：发布与运维有断点（可验证，非猜测）

- GitHub Releases 最新一条停在 **v2.5.23（2026-03-01）**，而 `package.json` 已是 **2.10.0**、tag 也打到 `v2.10.0`。也就是**六个月没发过正式 release**，但 README 声称桌面二进制"由同一发布流程产出、Stable"。
- HEAD 那次提交的 check-runs 我抽样了 100 条（共 365 条）：**93 成功 / 7 失败**，其中含 `Railway native deployment health`。
- 它自己的 issue 里有一条：`ops: 132k user-facing 400s over 3 days after the Aug 1 validation deploy raised no alert`。三万次面向用户的错误没触发告警——这是运维成熟度问题，不是代码问题。
- 代码里有 5 个空文件（0 字节）、若干 `<120B` 的占位模块；巨型单文件不少：`src/styles/main.css` **608KB**、`src/components/DeckGLMap.ts` **341KB**、`scripts/seed-forecasts.mjs` **883KB**、`scripts/ais-relay.cjs` **642KB**。
- 测试里有相当一部分是 `readFileSync` 读源码字符串再断言字面量存在（例：`tests/511-rate-limit.test.mjs`）。这叫**锁定实现而非验证行为**，是 AI 批量产出测试的典型形态——它会让你无法安全重构，因为改结构必挂测试。

### 1.5 问题四：增长数据与真实使用量不一致（这条我最不确信，所以把反证也放上）

**先放上我自己被推翻的怀疑：** 我最初认为"85k star 只有 495 人 watch"是异常。抓了对照组后这个论点站不住：

| 仓库 | stars | subscribers | star/sub |
|---|---|---|---|
| vitejs/vite | 82,646 | 561 | **147** |
| microsoft/playwright | 95,509 | 610 | **157** |
| shadcn-ui/ui | 122,747 | 429 | **286** |
| openclaw/openclaw | 388,542 | 1,754 | **222** |
| koala73/worldmonitor | 85,369 | 495 | **172** |

比例完全在同类仓库的正常区间内。这条我写错了，就在这里改正。

**仍然成立的三个观察：**

1. **曲线近乎线性。** 从 Wayback 存档的 GitHub 页面里提取 star 计数器（脚本 §9 会重跑）：

   | 日期 | stars | 与上一点的日均新增 |
   |---|---|---|
   | 2026-01-11 | 10 | — |
   | 2026-01-28 | 534 | +31/天 |
   | 2026-02-13 | 4,638 | +257/天 |
   | 2026-02-19 | 8,143 | +584/天 |
   | 2026-03-01 | 15,212 | +707/天 |
   | 2026-04-11 | 32,558 | +423/天 |
   | 2026-07-09 | 61,563 | +326/天 |
   | 2026-08-10 | 74,381 | +401/天 |
   | 2026-09-02 | 85,369 | +478/天 |

   全程平均 **+361/天，持续 8 个月**（自仓库创建日 01-08 起算）。真实传播通常是"尖峰 + 衰减"；这里既没有可见的尖峰，也没有衰减，反而是**匀速**——从 2 月到 9 月连续 7 个月稳定在每天 300–700 之间，这在自然传播里很少见。

   另一个细节：我抽样 Events API 的最近 24 小时（09-01→09-02），只有 **48 次 star**（约 48/天），比前三周的均值 **低一个数量级**。星数增长在这两天突然停了。这条我不做任何推断，只是记录下来——它和"自然热度缓慢衰减"的形态也不符。

2. **公开技术社区零热度。** 同一链接在 Hacker News 被提交 **18 次**（2026-02-13 → 07-22，不同账号），**最高 6 分、评论合计 7 条**。没有一次上热榜。一个 85k star 的项目在这个体量的社区里完全不存在，是不寻常的。

3. **开发者侧的实际使用极低。** 官方 CLI（npm 包 `worldmonitor`）最近一周下载 **96 次**，版本还停在 **0.1.3**；PyPI SDK 是 0.1.1。这两个包存在的唯一目的就是被开发者安装——85k star 对应 96 次/周，比值不合理。

4. 抽样最近 48 个 star 账号，**38% 是 2026 年新注册**（vite 25%、playwright 17%），并出现 `wendywallace19955-png`、`aihubworkflow`、`6255711-crypto`、`gjx2026821` 这类 0 仓库账号；`liuyh11` 在 2026-09-02 注册当天同时 fork + star。**这条证据很弱**——真实热点同样会吸引新号——所以我把它和对照组一起放进来，不单独下结论。

**我的结论**：不能断定它买过量。但"星数"作为可信度信号，在这个项目上**几乎没有信息量**。要看它，看代码、看站点、看 MCP 是否活着，别看 star。

### 1.6 一条方法论批评（适用于所有这类项目）

它有过这样一条 issue：`ops: 132k user-facing 400s ... raised no alert`。把 400 静默了三天。

我在做的过程中**踩到了同类的坑**：`metno` 适配器在 28 个城市全部返回 403 的情况下，界面上会显示"全球无极端天气"。这不是假设，是我真写出来过的代码——因为适配器只 `return []`，界面无法区分"没数据"和"抓坏了"。

所以本项目定了一条硬规矩：**适配器返回 0 条必须同时给原因**，`verify-sources` 会拒绝无理由的 0 条（详见 §6.2）。这是我从那个项目身上学到的最有价值的一课，虽然它自己没这么写。

---

## 2. 逐项对照

| | worldmonitor | intelmap |
|---|---|---|
| 环境变量 | 272 个键 | 33 个键，**全空也能跑** |
| 运行时依赖 | 49 deps + Vercel + Railway + Upstash + Convex + Clerk | **0**（只用 `node:http`/`fs`/`zlib`/`crypto`） |
| API 面 | 228 路径 / 2.8MB OpenAPI | 6 个端点 |
| 仓库体积 | 202 MB | **~250 KB** |
| AI 层 | LLM 摘要、预测、CII 指数、AI 分析师 | **无**。只有计数、比值、z-score |
| 新鲜度 | 不标注 | 每个源显示 last-run；**0 条必须说明原因** |
| 许可 | AGPL-3.0 + 商业双轨 + 商标限制 | MIT |
| 桌面端 / MCP / SDK | 有（4 个 SDK + MCP + Tauri） | 无 |
| 站点变体 | 6 个域名 | 1 个 |
| 交付节奏 | 5,599 PR / 8 个月（一人 + agent） | 我在一个会话里写完并验证 |

---

## 3. 界面

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ intelmap   [1h][6h][24h][3d][7d][30d]  [搜索______]  52s  抓取  自动  CSV     │
├──────────────┬─────────────────────────────────────────────┬─────────────────┤
│ 关注点        │ ●灾害 ●冲突 ●航空器 ●新闻事件 ●信号 …        │ 671 条 新增 12  │
│ 霍尔木兹 ✕   │      ┌─────────────────────────────┐        │ ▂▄▆▁▂▇▃▁ 60 桶  │
│ 红海 ✕ +[ ]  │      │ M6.1 · 千岛群岛             │        ├─────────────────┤
│ ☐ 只看命中    │ 事件 │ 滞后 42 秒 · 看原始来源 ↗   │        │ ●灾害 usgs      │
├──────────────┤      │ 原始字段（不加工）          │        │ ○信号 coingecko │
│ 图层          │      └─────────────────────────────┘        │ …               │
│ [点][热力]    │   地图 = 视野内带坐标的点；拖动/缩放重新取数  │                 │
│ [航迹][脉冲]  │                                             │                 │
├──────────────┤                                             │                 │
│ 信号源 16/19 │                                             │                 │
│ ☑ USGS   64  │                                             │                 │
│ ☐ ACLED      │                                             │                 │
│   缺少密钥    │                                             │                 │
├──────────────┤                                             │                 │
│ 采集健康      │                                             │                 │
│ ● usgs 64·2m│                                             │                 │
│ ● gdelt 501·1│                                             │                 │
└──────────────┴─────────────────────────────────────────────┴─────────────────┘
```

- **地图只画当前视野内带坐标的点**，拖动/缩放按 `bbox` 重新取数——不这么做，全球尺度必然卡死。
- **关注点**是本地的：几个关键词，命中就描金边。纯字符串匹配，可审计，不发出去。
- 每个事件详情都写「事件时间 / 我们知道的时间 / 滞后多久」。情报工具里最该有、最常见的却没有的字段。
- 快捷键：`/` 搜索、`⌘/Ctrl+R` 抓取、`Esc` 关详情。

---

## 4. 数据源（全部 2026-09 实测）

免密钥直接可用：

| 源 | 内容 | 一轮实测 |
|---|---|---|
| USGS ×2 | 全球地震 M2.5+ / 显著地震 | 61 + 13 条，5 分钟级 |
| NASA EONET | 野火/风暴/火山，含最新位置 | 250 条 |
| NOAA SWPC | 耀斑 + 地磁 Kp | 0 条（太阳平静，会写明原因） |
| MET Norway | 28 个关注城市极端天气 | 1 条 |
| OpenSky ×3 | 欧/东地中海/东亚空域 | **2,784 架次 → 40 条密度格** |
| GDELT 事件表 | **全球逐事件 + 自带经纬度**，15 分钟 | **501 条** |
| GDELT 时间线 | 8 个话题的报道量比值 | 6 条 |
| 世行 / Comtrade | 宏观指标 / HS 编码贸易流 | 157 / 3 条 |
| OFAC / OpenSanctions | 制裁名单指纹 / 名单更新状态 | 1 / 14 条 |

需注册才启用（缺 key 时干净禁用并说明，不报错刷屏）：ACLED、UCDP、aisstream。

```bash
node scripts/verify-sources.mjs     # 逐源实测：几条、带不带坐标、最新事件多久前、0 条是为什么
```

---

## 5. 上游源的坑（都实测踩过，别再踩一遍）

1. **GDELT 事件表是 Tab 分隔，不是逗号。** 按逗号切只得到 7 个字段，然后**静默产出 0 条**。
2. **GDELT 出错返回纯文本**（`Parentheses may only be used around OR'd statements.`），`JSON.parse` 只会给你一句 "Unexpected token 'P'"。必须显式识别非 JSON 响应。
3. **GDELT 查询语法**：空格即 AND；`A OR B` **必须整体加括号**；含连字符的词（`no-fly`）**必须加引号**。限速名义 1 请求/5 秒，实测 **10–12 秒**才稳。
4. **MET Norway 会拒绝 UA 里含 email 字样的请求**：`contact: you@example.com` → 403；换成 URL 形式 → 200。
5. **UN Comtrade** 加 `customsCode` / `motCode` 参数会被判 `Invalid parameter value`。最小参数集才通。
6. **OFAC SDN 全量约 29MB**。别傻拉——拉一次算指纹，只有真变了才产事件。
7. `raw.githubusercontent.com` 在部分网络下不可达（本沙箱实测不通）。用 GitHub Contents API 的 `application/vnd.github.raw` 变体。

## 6. 我自己代码里的 bug（被自家检查抓出来的）

写这个项目时我一共踩了这些坑，全部有对应的自动化检查兜住：

### 6.1 分片按"事件日"切 → 重启后重复入库
EONET 里 2019 年就开始的干旱，`ts` 落在保留窗口外，重启后既不进索引、又因去重集缺失而**每轮重复入库**。改成按**入库日**切分。实测：重启后回放 763 条、仅 +18 条真新事件、**0 个重复 id**。

### 6.2 把故障渲染成平静（最严重的一个）
`metno_hazard` 在 **28 个城市全部 403** 的情况下，仍然报告"均未越阈值 → 无极端天气"。这正是 §1.6 批评的行为，我自己先写出来了。

修复分两层：适配器必须返回 `{ events, note }`；`note` 进健康记录并显示。现在同一次故障的输出是：

```
metno_hazard  取回 0 新增 0   全部 28 个城市抓取失败（403×28）——这是故障，不是「无极端天气」
```

`verify-sources.mjs` 会把"0 条且无原因"标成 `⚠ 无法区分「没数据」和「抓坏了」`并让进程退出码非 0。

### 6.3 README 里写"3–8MB/天"是拍脑袋的
实测 GDELT 在默认阈值下是 **22MB/天、30 天 0.63GB，且全部常驻内存**。于是加了**分源保留期**（GDELT `keep_days: 5`，世行 `400`），并把阈值从 5 调到 10 → 9MB/天。现在 README 里的数字都是测出来的：

| min_articles | 条/片 | 条/天 | 明文/天 | 30 天 |
|---|---|---|---|---|
| 1（不过滤） | 1,178 | 113k | 59 MB | 1.7 GB |
| **10（默认）** | **178** | **17k** | **9 MB** | **0.26 GB** |
| 20 | 6 | 576 | 0.3 MB | 0.01 GB |

因此分片键是 `kind/source/day` 三级：同一文件里混着两种保留期的源，就没法既省内存又不丢历史。

### 6.4 `raw()` 对所有响应做 JSON 校验
把**本来就是纯文本**的 `lastupdate.txt` 判成错误，501 条事件全丢。加了 `expectJson` 开关。

另外：`fitCanvas()` 挂在 `map.on('render')` 上每帧重设 canvas 尺寸（强制清空 + 触发布局）、`#csv.firstChild` 取到按钮而非 `<a>`、`pkill -f 'src/server.mjs'` 把我的 shell 自己杀掉——这些都是过程中真实出现过并修掉的。

## 7. 怎么跑

```bash
git clone <本仓库> && cd intelmap
npm start                    # → http://127.0.0.1:8787   无需 npm install
npm test                     # 三层验收：静态核对 + API 28 项 + 前端渲染 16 项
```

小 VPS 常驻：`docker compose up -d`（compose 里只绑 127.0.0.1，远程访问请走 Tailscale/SSH 隧道——**这工具没有鉴权，别暴露公网**）。

抓取与查询解耦（推荐，前端永远秒开）：

```bash
NO_INGEST=1 node src/server.mjs
*/5 * * * * cd /opt/intelmap && node src/refresh.mjs >> /var/log/intelmap.log 2>&1
```

## 8. 加一个源（前端零改动）

`sources.json` 加一条 + `src/adapters/` 任一模块导出同名函数：

```js
export async function your_feed({ source, log }) {
  const d = await get(source.url, { ttl: 300 });
  const events = d.items.map(x => ({
    key: x.id, ts: Date.parse(x.time) / 1000,
    lat: x.lat, lon: x.lon,            // 可空 → 不进地图，仍进事件流
    title: x.title, url: x.link,
    tags: ['your_feed'], weight: x.severity, ttl: 86400,
    meta: x,                           // 原样保留，前端「原始字段」里可看
  }));
  return { events, note: events.length ? null : '上游返回空列表（当日无事件）' };
}
```

## 9. 复核我的说法

```bash
node scripts/probe-upstream.mjs > docs/upstream-evidence.json
```

它抓：仓库基本面与体量、`.env.example` 键数、release/tag/发布间隔、52 周提交曲线、作者集中度、issue/PR 计数、HEAD 的 CI 成败、npm 周下载、目录树统计、**Wayback 上的 star 曲线**、HN Algolia 投稿记录、近期 star 账号年龄（含 vite/playwright 对照组）。

结果存在 [`docs/upstream-evidence.json`](docs/upstream-evidence.json)。所有数字都应能由这个脚本重跑出——不能重跑的我就不写进 README。

## 10. 许可与合规

代码 **MIT**。但**上游数据许可与代码许可无关**：ACLED 禁止再分发、Met Norway 要求署名、OpenSky 是 browse-only、aisstream 禁止留存衍生数据、GDELT 要求署名。自用没事；**要把看板公开或对数据二次分发，逐源重读条款。**

## 11. 明确不做

1. 不做 LLM 摘要、预测、"稳定性指数"。要判断，自己看原始链。
2. 不做 MCP server / SDK / 站点变体 / 桌面端——那是要给别人用的产品才需要的东西。
3. 不做账号、付费墙、SEO。
4. 不接必须付费才能看的数据。宁可少一个源，也不让项目变成"不花钱就不完整"。
