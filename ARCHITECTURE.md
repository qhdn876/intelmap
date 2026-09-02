# intelmap 设计说明

个人用全球态势看板。目标：**数据源多、延迟透明、零 AI、零框架、能在一台小 VPS 上跑十年。**

## 与 worldmonitor 的分野

| worldmonitor | intelmap |
|---|---|
| 272 个环境变量、228 个 API 路径 | 一个 `sources.json`，键可选填 |
| 6 站点变体 + Tauri + MCP + 4 个 SDK | 一个静态页 + 一个 JSON API |
| LLM 合成摘要 / 预测 / CII 指数 | 不做任何推断；只给计数、异常检测、原始链 |
| AGPL 服务端 + 商业授权双轨 | MIT |
| 不标数据新鲜度 | **过期源自动灰显并标注 last-run 时间**（核心差异） |
| 341KB 单文件组件、608KB 单 CSS | 每个采集器 ≤150 行，UI 单文件 |

## 分层

```
sources.json ──┐
               ├─▶ scheduler ─▶ registry ─▶ ingest ─▶ JSONL 分片 ─▶ /api/*  ─▶ 静态前端
adapters/*.mjs ─┘                   │
   自描述：kind / interval / bbox / key_required
                                    └─▶ anomaly（仅计数偏离，无模型）
```

- **registry**（`src/registry.mjs`）：加载 `sources.json` + `src/adapters/*.mjs`，自描述能力（kind、更新周期、是否需 key、是否带经纬度）。前端的能力面板由它驱动 —— 加一个源不用改 UI。
- **ingest**：统一 envelope（见下），负责去重、TTL、抓取日志、错误退避。
- **api**：4 个只读端点。
- **存储**（`src/store.mjs`）：按 kind/入库日 切分的 JSONL + 内存索引。个人规模（每天几千条）下这比数据库省心：`grep` 就能查，坏了删一天重跑。要换 SQLite/DuckDB 只需改这一个文件，接口只有 4 个方法。

- **web**：MapLibre 底图 + 一个自绘 canvas 叠加层。**没有 React/Vue/deck.gl**。

## envelope

每条记录归一化成同一个形状，这是整个项目最重要的约定：

```json
{
  "id": "sha1(source:key)",
  "source": "usgs_quakes",
  "kind": "disaster",
  "ts": 1770000000,          // 事件发生时间
  "ingest_ts": 1770000060,   // 我们知道的时间
  "lat": 35.1, "lon": 139.2, // 可空 → 不进地图
  "title": "M 6.1 ...",
  "body": "",
  "url": "https://...",
  "tags": ["quake","m6"],
  "weight": 6.1,             // 点大小/热度权重
  "ttl": 86400,              // 过期后前端灰显
  "meta": {}                 // 源特有字段，原样保留
}
```

`ts` 与 `ingest_ts` 分开存，这样"某地事件"和"我们何时知道"不会混淆 —— 复盘时有用。

## 为什么不用 React / deck.gl / PostGIS

- 面板数量固定在 10 个以内，命令式 DOM 比组件树更好读。
- 地图点数 < 20k，MapLibre 的 GeoJSON source + 一个 canvas 叠加层足够；deck.gl 只在百万级点时才值得。
- SQLite 的 RTREE 能建空间索引，但个人规模（30 天、每天几千条）下线性扫描就是毫秒级，索引只是多一层心智负担。

## 阈值

| 源类型 | 建议周期 | 理由 |
|---|---|---|
| 突发型（地震/灾害/NOTAM/ADS-B） | 60–120s | 低于此值只是自我折磨 |
| 小时型（GDELT/OFAC/航运指数） | 15–60min | GDELT 本身 15 分钟更新 |
| 日更（ACLED/EIA/世行） | 24h | 日更源按小时抓是纯浪费配额 |

## 明确不做

1. 不接付费源（Finnhub/Wingbits/ACLED 商用受限）。
2. 不做前端到第三方 API 的直连 —— 全部经服务端代理，密钥不进浏览器，CORS 一次解决。
3. 不自动合并/部署代码。
4. 不做需要模型才能回答的功能。想清楚这一点，80% 的"AI 情报"需求会自动消失。
