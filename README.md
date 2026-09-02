# intelmap

个人用的全球态势看板。**多数据源、延迟透明、零 AI、零框架、零运行时依赖。**

```bash
git clone <你的仓库> intelmap && cd intelmap
npm start                 # 打开 http://127.0.0.1:8787
```

不需要 `npm install` —— 后端只用 Node 内置模块（`node:http` / `node:fs` / `node:zlib` / `node:crypto`）。
前端从 CDN 取 MapLibre。一个源都不用配密钥就能出数据；填了 key 只是加源。

---

## 为什么长这样

这个项目是照着 [koala73/worldmonitor](https://github.com/koala73/worldmonitor) 的反面做的。
它 8 个月 8.5 万 star，技术上确实有货（1,800 个 TS 文件、300+ proto、2,000 个测试），但作为**个人**使用者你会撞上三堵墙：

| 那堵墙 | 这里的做法 |
|---|---|
| `.env.example` 272 个键、228 个 API 路径、Vercel+Railway+Upstash+Convex | 1 个 `sources.json` + 4 个只读端点，密钥全可选 |
| 「不配付费数据源就大面积空面板」，但界面不告诉你哪个面板是死的 | **每个源显示 last-run 与错误；取回 0 条必须自报原因**（见下） |
| LLM 合成摘要 / 预测 / 稳定性指数——把幻觉包装成权威 | 只有计数、比值、z-score。判断留给你 |

最有意思的一条：**「0 条」到底是没数据还是抓坏了**，是最容易骗过自己的东西。
所以这里的适配器允许返回 `{ events, note }`，`note` 会被存进健康记录并显示在界面上：

```
noaa_spacewx    取回 0 新增 0   太阳平静：峰值通量 1.5e-6 < M1000，Kp 4.3 < 6
metno_hazard    取回 0 新增 0   全部 28 个城市抓取失败（403×28）——这是故障，不是「无极端天气」
```

第二行是真踩过的：MET Norway 会拒绝**含 email 字样的 User-Agent**（`contact: you@example.com` → 403，换成 URL 形式就 200）。如果适配器只 `return []`，界面就会显示"全球无极端天气"，而实际上是 28 个请求全挂了。

## 界面

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ intelmap   [1h][6h][[24h]][3d][7d][30d]   [搜索________]   52s后刷新 抓取 自动 │
├──────────────┬────────────────────────────────────────────┬──────────────────┤
│ 关注点        │  ●灾害 ●冲突 ●航空器 ●新闻事件 ●信号 …       │ 671 条  本轮新增 12│
│ 霍尔木兹 ✕   │                                            │ ▂▄▆▁▂▇▃▁  ← 60桶  │
│ 红海 ✕  +[ ] │      ┌──────────────────────────┐          ├──────────────────┤
│ ☐ 只看命中    │      │ M6.1 · 千岛群岛          │          │ 09-02            │
├──────────────┤ 事件 │ 滞后 42秒 · 看原始来源 ↗ │          │ ●灾害 usgs_quakes│
│ 图层          │      │ 原始字段（不加工）       │          │   M6.1 · 千岛群岛│
│ [点][热力]    │      └──────────────────────────┘          │ ○信号 coingecko  │
│ [航迹][脉冲]  │                                            │   BTC 急跌 4.2%  │
├──────────────┤        地图 = 当前视野内带坐标的点           │   …401 行…       │
│ 信号源 16/19  │                                            │                  │
│ ☑ USGS 地震 64│                                            │                  │
│ ☐ ACLED      │                                            │                  │
│   缺少密钥    │                                            │                  │
├──────────────┤                                            │                  │
│ 采集健康      │                                            │                  │
│ ● usgs 64条·2m│                                           │                  │
│ ● gdelt 501·1m│                                           │                  │
└──────────────┴────────────────────────────────────────────┴──────────────────┘
```

三栏：左边源清单/健康/关注点，中间地图，右边事件流。

- **地图只画当前视野内带坐标的点**，拖动/缩放会按 `bbox` 重新取数——不这么做，全球尺度下浏览器必然卡死。
- **关注点**是本地的：输入几个词（如 `霍尔木兹`），命中的事件高亮。纯字符串匹配，可审计，不发出去。
- 图层可切：热力 / 航迹（同一目标按时间串成线）/ 新事件脉冲。
- 每个事件详情都写清「事件时间」和「我们知道的时间」，滞后多少一目了然。
- 快捷键：`/` 搜索、`⌘/Ctrl+R` 立刻抓取、`Esc` 关详情。

## 数据源

全部是 2026-09 实测。免密钥的直接用，要 key 的默认禁用。

| 源 | 内容 | 密钥 | 实测坑 |
|---|---|---|---|
| USGS | 全球地震 M2.5+，5 分钟 | 无 | 公共领域，最省心的一个 |
| NASA EONET | 野火/风暴/火山等自然灾害 | 无 | 事件的 `ts` 可能是几年前（干旱），别按事件日分片 |
| NOAA SWPC | 耀斑 / 地磁 Kp | 无 | 只报 M 级以上，其余时候是"平静" |
| MET Norway | 28 个关注城市极端天气 | 无 | **UA 里不能出现 email 字样**，否则 403 |
| OpenSky | 空域快照（按区域 bbox） | 可选 | 匿名限额低；必须给 bbox，全球全量拉不动 |
| GDELT 事件表 | 全球逐事件+经纬度，15 分钟 | 无 | **Tab 分隔**不是逗号；61 列 |
| GDELT 时间线 | 话题报道量比值 | 无 | 出错返回**纯文本**；OR 必须整体加括号；带连字符的词要引号；限速实际要 10s |
| CoinGecko | 加密资产异动 | 无 | 限速严，别当行情主源 |
| 世行 / Eurostat | 宏观指标 | 无 | 年度数据，作用是给地图铺基本面底色 |
| UN Comtrade | 贸易流 | 可选 | preview 免 key；**加 `customsCode`/`motCode` 会被判非法参数** |
| OFAC SDN | 制裁名单 | 无 | 全量 29MB → 只算指纹，变了才产一条事件 |
| OpenSanctions | 400+ 名单的元数据 | 无 | 轻量，适合看"哪条名单在动" |
| ACLED / UCDP | 冲突事件点 | 需注册 | 非商用免费，禁止再分发 → 只适合本地自用 |
| aisstream | 船舶位置（WebSocket） | 需注册 | 非轮询；条款禁止长期留存 → TTL 只给 15 分钟 |

自检：

```bash
node scripts/verify-sources.mjs        # 逐源实测：能取回几条、带不带坐标、最新事件多久前、0 条是为什么
node scripts/smoke.mjs                 # API 层：28 项断言（信封形状 / 过滤 / 健康记录 / 405 / 目录穿越）
node scripts/render-check.mjs          # 前端层：用假 DOM 真跑 app.js，16 项断言
npm test                               # 三层一起跑
```

`render-check.mjs` 存在的理由：沙箱里没有浏览器，而"后端全绿、打开页面白屏"恰恰是最常见的那类失败。
它自己拉起服务、造一个够用的 DOM/MapLibre/canvas 替身，把 `app.js` 真执行一遍，然后断言源清单、图例、
事件流、CSV 链接确实被填上了。它不替身的东西（比如 `boot()` 的 `.catch` 会把异常咽成一行提示）都单独查了一遍。

## 加一个源

两步，前端不用改任何东西。

**1)** `sources.json` 加一条：

```json
{
  "id": "your_feed",
  "adapter": "your_feed",
  "group": "conflict",
  "label": "你的数据源",
  "kind": "conflict",
  "points": true,
  "interval": 900,
  "license": "CC BY-NC，禁止再分发",
  "url": "https://example.com/feed.json"
}
```

**2)** `src/adapters/` 里任一模块导出同名函数：

```js
export async function your_feed({ source, log }) {
  const d = await get(source.url, { ttl: 300 });
  const events = d.items.map(x => ({
    key: x.id, ts: Date.parse(x.time) / 1000,
    lat: x.lat, lon: x.lon,           // 可空 → 不进地图，仍进事件流
    title: x.title, url: x.link,
    tags: ['your_feed'], weight: x.severity, ttl: 86400,
    meta: x,                          // 原样保留，前端「原始字段」里能看
  }));
  return { events, note: events.length ? null : '上游返回空列表（当日无事件）' };
}
```

`kind` 决定配色和分组，见 `src/envelope.mjs` 的 `KINDS`。加新类型也在那里加一行。

## 部署

**只想在自己机器上看：** `npm start`，浏览器开 `127.0.0.1:8787`。

**小 VPS 常驻：**

```bash
cp .env.example .env      # 改 HTTP_UA 里的联系方式、按需填 key
docker compose up -d      # 或见下方 systemd
```

systemd（不用 Docker 的话）：

```ini
# /etc/systemd/system/intelmap.service
[Unit]
Description=intelmap
After=network-online.target
[Service]
WorkingDirectory=/opt/intelmap
ExecStart=/usr/bin/node src/server.mjs
EnvironmentFile=/opt/intelmap/.env
Restart=always
User=intelmap
[Install]
WantedBy=multi-user.target
```

**分离模式**（推荐给自己长期跑）：抓取和查询解耦，前端永远秒开，抓取慢也不影响界面。

```bash
NO_INGEST=1 node src/server.mjs          # 只查询
crontab -e: */5 * * * * cd /opt/intelmap && node src/refresh.mjs >> /var/log/intelmap.log 2>&1
```

**别把它暴露到公网。** 这工具的定位是"你自己看"，没有鉴权；要远程访问就套 Tailscale 或 SSH 隧道。

## 数据量与成本

不是估算，是实测（`node src/refresh.mjs` 跑满一轮，2026-09-02）：

| 项 | 实测 |
|---|---|
| 一轮（13 个免密钥源出数） | **781 条事件 / 480 KB 明文 / 约 60 秒** |
| 重启后 | 回放 763 条，仅 +18 条真新事件，**0 重复 id** |
| 单轮出站流量 | 大头是 OFAC 29MB（日更）+ GDELT 分片 0.5MB×96 |
| 常驻内存 | ≈ 事件条数 × 600B，当前量级 < 1 MB |
| 钱 | **0 元**（ACLED 商用授权另计） |

唯一需要你调的旋钮是 GDELT 的 `min_articles`。它的体量比其余所有源加起来还大，实测一张 15 分钟分片：

| min_articles | 条/片 | 条/天 | 明文/天 | 30 天 |
|---|---|---|---|---|
| 1（不过滤） | 1178 | 113k | 59 MB | 1.7 GB |
| **10（默认）** | **178** | **17k** | **9 MB** | **0.26 GB** |
| 20 | 6 | 576 | 0.3 MB | 0.01 GB |

所以 `sources.json` 里 GDELT 的 `keep_days` 只有 5 天，而世行是 400 天 —— 一刀切的 `KEEP_DAYS` 一定会留错东西。**分片按 `kind/source/day` 三级**就是为此：同一文件里混着两种保留期的源，就没法既省内存又不丢历史。


## 许可

MIT。但**上游数据的许可与代码许可无关**：ACLED 禁止再分发、OpenSky 是 browse-only、Met Norway 要求署名、aisstream 禁止留存衍生数据。自用没事，**要把这个看板公开或对数据做二次分发之前，逐源重读条款**。

## 明确不做

1. 不做 LLM 摘要、预测、"稳定性指数"。要判断，自己看原始链。
2. 不做 MCP server / SDK / 站点变体 / 桌面端。那是要给别人用的产品才需要的东西。
3. 不做账号、付费墙、SEO。
4. 不接需要付费才能看的数据。宁可少一个源，也不要让项目变成"必须花钱才完整"。
