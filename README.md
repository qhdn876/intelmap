# intelmap

个人用全球态势看板。**免密钥数据源、零运行时依赖、零 AI、延迟透明。**
单进程 `node src/server.mjs` 起服务，`npm start` 到打开页面之间不需要任何安装步骤。

参考 [koala73/worldmonitor](https://github.com/koala73/worldmonitor) 重写，面向个人使用场景裁剪：去掉 AI 层、桌面端、多站点变体，只留数据采集、归一化、地图渲染。

## 当前数据源

### 新闻事件（结构化）
- **GDELT 事件表**：全球逐事件 + 自带经纬度，15 分钟更新
- **GDELT 报道量时间线**：话题升温/降温检测（台海、红海、乌克兰、中美贸易、美联储等）
- **GDELT 定向文章流**：按主题读原文

### 经济 / 市场
- **华尔街见闻热榜**：via RSSHub
- **华尔街见闻快讯**：via RSSHub

### 宏观经济
- **世行宏观指标**：GDP、CPI、债务、汇率等年度数据
- **UN Comtrade 贸易流**：中国进出口 HS 编码数据
- **FRED 美联储数据**（待启用）：联邦基金利率、CPI、失业率、10年国债、人民币汇率

### 制裁 / 治理
- **OFAC SDN 名单变化**：指纹比对，名单变了才产事件
- **OpenSanctions 名单更新**：聚合 400+ 制裁/PEP/黑名单

### 舆论 / 热搜
- **微博热搜**：via RSSHub
- **知乎热榜**：via RSSHub
- **百度热搜**：via RSSHub
- **Twitter 关注账号**（待启用）：via RSSHub，需要 cookie

## 怎么跑

```bash
git clone <本仓库> && cd intelmap
npm start                    # → http://127.0.0.1:8787   无需 npm install
npm test                     # 三层验收：静态核对 + API 28 项 + 前端渲染 16 项
```

小 VPS 常驻：`docker compose up -d`

**部署到公网必须设鉴权**：`.env` 里加 `INTELMAP_AUTH=user:password`

## 待启用（TODO）

| 功能 | 需要什么 | 状态 |
|---|---|---|
| FRED 美联储数据 | 免费 API key | [申请地址](https://fred.stlouisfed.org/docs/api/api_key.html) |
| Twitter 监控 | RSSHub 配置 `TWITTER_AUTH_TOKEN` | 浏览器登录 x.com → F12 → Cookies → auth_token |
| HTTPS 域名 | 域名 + DNS 指向 VPS | 用 Caddy 自动证书 |

启用方法：填 `.env` 里的对应值，sources.json 里删掉 `disabled_note` 字段即可。

## 架构

```
sources.json ──┐
               ├─▶ scheduler ─▶ registry ─▶ ingest ─▶ JSONL 分片 ─▶ /api/*  ─▶ 静态前端
adapters/*.mjs ─┘                   │
   自描述：kind / interval / bbox    └─▶ anomaly（仅计数偏离，无模型）
```

- **registry**：加载 sources.json + adapters/*.mjs，前端能力面板由它驱动
- **ingest**：统一 envelope，去重、TTL、抓取日志、错误退避
- **存储**：按 kind/source/day 切分的 JSONL + 内存索引
- **web**：MapLibre 底图 + 自绘 canvas，无框架

## 加一个源

`sources.json` 加一条 + `src/adapters/` 任一模块导出同名函数：

```js
export async function your_feed({ source, log }) {
  const d = await get(source.url, { ttl: 300 });
  const events = d.items.map(x => ({
    key: x.id, ts: Date.parse(x.time) / 1000,
    lat: x.lat, lon: x.lon,
    title: x.title, url: x.link,
    tags: ['your_feed'], weight: x.severity, ttl: 86400,
    meta: x,
  }));
  return { events, note: events.length ? null : '上游返回空列表' };
}
```

## RSSHub 依赖

本项目的 RSS 源（华尔街见闻、财新、微博、知乎、百度、Twitter）依赖 RSSHub 实例。

自托管（推荐）：
```bash
docker run -d --name rsshub -p 1200:1200 diygod/rsshub
```

或用公共实例（限速严格，不建议生产用）：把 sources.json 里的 `localhost:1200` 换成 `rsshub.app`。

## 许可

代码 MIT。上游数据许可与代码许可无关。
