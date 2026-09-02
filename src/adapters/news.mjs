// GDELT 2.0 —— 免费源里唯一「全球 / 逐事件 / 自带经纬度 / 每 15 分钟」的结构化事件表。
// 实时性接近 ACLED，却不用注册。代价是要自己踩三个坑，我都踩完了，写在下面。
//
// 坑 1：export.CSV 是 **Tab 分隔**，不是逗号。按逗号切只得到 7 个字段，然后静默产出 0 条。
// 坑 2：API 出错时返回的是**纯文本**（限速提示、语法投诉），不是 JSON。
//        直接 JSON.parse 会得到一句没头没尾的 “Unexpected token 'P'”。
// 坑 3：查询语法 —— 空格是 AND；`X AND Y` 也合法；但 **OR 必须整体包在括号里**，
//        `"red sea" OR gulf` → BAD，`("red sea" OR gulf)` → OK。
//        并且限速是「每 5 秒 1 次」，实测要 10 秒才稳。
import { HttpError, sleep } from '../http.mjs';
import { unzipFirst } from '../zip.mjs';

const UA = 'intelmap/0.1 (+https://github.com/you/intelmap)';
const GAP_MS = Number(process.env.GDELT_GAP || 12000);

const COL = {
  id: 0, day: 1,
  actor1Country: 7, actor2Country: 17, actor1Type1: 12,
  isRoot: 25, eventCode: 26, eventRoot: 28, quadClass: 29, goldstein: 30,
  mentions: 31, sources: 32, articles: 33, tone: 34,
  geoType: 51, geoName: 52, geoCountry: 53, geoAdm1: 54, geoLat: 56, geoLon: 57,
  dateAdded: 59, url: 60,
};

// CAMEO 根代码 → 中文标签 + 视觉权重（01–20 是 GDELT 的事件大类）
const ROOT = {
  '01': ['公开表态', 0.5], '02': ['提出呼吁', 0.7], '03': ['外交交流', 0.8], '04': ['提供援助', 0.9],
  '05': ['制裁/限制', 1.6], '06': ['降低关系', 1.3], '07': ['武力威胁', 2.2], '08': ['抗议示威', 1.7],
  '09': ['封锁/禁运', 2.2], '10': ['突袭缴获', 2.4], '11': ['暴力镇压', 3.2], '12': ['武装袭击', 3.6],
  '13': ['军事交火', 4.2], '14': ['大规模暴力', 5.0], '15': ['逮捕拘留', 1.5], '16': ['非暴力抵抗', 1.2],
  '17': ['强制流离', 2.8], '18': ['去军事化', 1.6], '19': ['封锁空域海域', 2.6], '20': ['进入/占领领土', 2.7],
};

// 纯字符串打标：可审计、可自己加词、不引入任何模型。
const KEYWORDS = {
  空域关闭: ['airspace closed', 'no-fly zone', 'closed its airspace'],
  海峡通行: ['hormuz', 'bosporus', 'bosphorus', 'dardanelles', 'malacca'],
  红海航运: ['red sea', 'aden bay', 'houthi'],
  海底电缆: ['submarine cable', 'undersea cable', 'seacom'],
  网络攻击: ['cyberattack', 'ransomware', 'data breach', 'hackers'],
  半导体管制: ['semiconductor', 'chip export', 'export control'],
  能源设施: ['lng terminal', 'pipeline', 'refinery', 'power grid', 'substation'],
  粮食供应: ['grain export', 'wheat', 'food shortage'],
  航空器损失: ['plane crash', 'aircraft crash', 'jet crashed', 'shot down'],
};
const tagByText = (...ts) => {
  const s = ts.join(' ').toLowerCase();
  return Object.entries(KEYWORDS).filter(([, ks]) => ks.some(k => s.includes(k))).map(([tag]) => tag);
};

const yyyymmddhhmmss = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000) : null;
};
const yyyymmdd = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(s || '').trim());
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], 12) / 1000) : null;
};
const isodate = (s) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(String(s || ''));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 1000) : 0;
};

async function raw(url, { asBuffer = false, expectJson = true } = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  } catch (e) {
    // 部分网络/CDN 会中途重置这个域的 TLS；GDELT 同时服务明文 http，退回一次
    if (!/^https:/.test(url)) throw new HttpError(`GDELT 抓取失败: ${e.message}`, { url });
    try {
      res = await fetch(url.replace(/^https:/, 'http:'), { headers: { 'user-agent': UA }, redirect: 'follow' });
    } catch (e2) {
      throw new HttpError(`GDELT 抓取失败: ${e2.message}`, { url });
    }
  }
  if (!res.ok) throw new HttpError(`GDELT HTTP ${res.status}`, { status: res.status, url });
  if (asBuffer) return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  // lastupdate.txt 是纯文本清单，不能拿 JSON 规则去卡它 —— expectJson 只给 API 端点用
  if (expectJson) {
    const t = text.trim();
    if (t[0] !== '{' && t[0] !== '[') {
      const rate = /limit requests/i.test(t);
      throw Object.assign(new HttpError(`GDELT 纯文本响应：${t.slice(0, 90)}`, { status: rate ? 429 : 200, url }),
        { ratelimited: rate });
    }
    return JSON.parse(text);
  }
  return text;
}

/** 事件表：一个 15 分钟分片约 1000–2000 行，靠 min_articles 挡掉低置信度行。 */
export async function gdelt_events({ source, log }) {
  const minArticles = source.min_articles ?? 5;
  const indexUrl = source.index_url || 'http://data.gdeltproject.org/gdeltv2/lastupdate.txt';
  const idx = await raw(indexUrl, { expectJson: false });
  const shard = String(idx).split('\n').map(l => l.trim().split(/\s+/)).find(c => String(c[2]).endsWith('export.CSV.zip'))?.[2];
  if (!shard) throw new HttpError('lastupdate.txt 里找不到 export.CSV.zip 分片', { url: indexUrl });

  const buf = await raw(shard, { asBuffer: true });
  const { data, name } = unzipFirst(buf);
  const now = Math.floor(Date.now() / 1000);
  const out = [];
  let rows = 0, kept = 0, noGeo = 0;

  for (const line of data.toString('utf8').split('\n')) {
    if (!line || line.length < 60) continue;
    const f = line.split('\t');
    if (f.length !== 61) continue;                        // 非标准列数直接跳过，别猜
    rows++;
    const lat = Number(f[COL.geoLat]), lon = Number(f[COL.geoLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) { noGeo++; continue }
    const articles = Number(f[COL.articles]) || 1;
    if (articles < minArticles) continue;
    kept++;
    const root = String(f[COL.eventRoot]).padStart(2, '0');
    const [label, baseW] = ROOT[root] || ['事件', 1];
    const place = f[COL.geoName] || f[COL.geoCountry] || '未知位置';
    const tone = Number(f[COL.tone]);
    const quad = Number(f[COL.quadClass]);
    out.push({
      key: `gdelt:${f[COL.id]}`,
      ts: yyyymmddhhmmss(f[COL.dateAdded]) || yyyymmdd(f[COL.day]) || now,
      lat, lon,
      title: `${label} · ${place}${f[COL.actor2Country] && f[COL.actor2Country] !== f[COL.actor1Country] ? ` ↔ ${f[COL.actor2Country]}` : ''}`,
      url: f[COL.url] || null,
      tags: ['gdelt', `cameo:${root}`, f[COL.geoCountry],
             ['12', '13', '14', '11', '17', '18', '20'].includes(root) ? 'violent' : null,
             quad === 4 ? 'material-conflict' : quad === 3 ? 'verbal-conflict' : quad === 2 ? 'material-coop' : 'verbal-coop',
             ...tagByText(place, f[COL.url])].filter(Boolean),
      weight: +(baseW * Math.min(4, 1 + Math.log10(articles))).toFixed(2),
      ttl: 86400 * 3,
      meta: {
        cameo_root: root, label, quad, goldstein: Number(f[COL.goldstein]),
        articles, mentions: Number(f[COL.mentions]), distinct_sources: Number(f[COL.sources]),
        avg_tone: Number.isFinite(tone) ? +tone.toFixed(2) : null,
        actor1: f[COL.actor1Country] || null, actor2: f[COL.actor2Country] || null,
        adm1: f[COL.geoAdm1] || null, event_day: f[COL.day], shard: name,
      },
    });
  }
  log?.(`  · gdelt_events: ${rows} 行 → ${kept} 条（无坐标 ${noGeo}，低于 articles>=${minArticles} 的已丢弃）`);
  return {
    events: out,
    note: out.length ? null : `${rows} 行里 ${noGeo} 行无坐标、其余未达到 articles>=${minArticles} —— 是阈值问题，不是抓取失败`,
  };
}

/**
 * 报道量时间线：话题是否在升温。
 * 这是「不用 AI 也能有判断」的核心取舍 —— 一个计数比值就能回答「这里出事了吗」。
 * ratio = 后半段均值 / 前半段均值；>=1.8 记为升温。
 */
export async function gdelt_timeline({ source, log }) {
  const out = [];
  const failed = [];
  let limited = false;
  for (const q of source.queries || []) {
    const params = new URLSearchParams({
      query: q.q, mode: 'TimelineVolRaw', format: 'json',
      timespan: source.timespan || '24h', span: source.span || '1h',
    });
    if (out.length || failed.length) await sleep(GAP_MS);
    try {
      const j = await raw(`${source.url}?${params}`);
      const series = (j.timeline || []).find(x => /article/i.test(x.series)) || j.timeline?.[0];
      const pts = (series?.data || []).map(p => [isodate(p.date), Number(p.value) || 0]).filter(p => p[0]);
      if (pts.length < 6) { failed.push(`${q.tag}: 数据点 ${pts.length}<6`); continue }
      const half = Math.floor(pts.length / 2);
      const mean = (a) => a.reduce((s, [, v]) => s + v, 0) / (a.length || 1);
      const base = mean(pts.slice(0, half)), cur = mean(pts.slice(half));
      const ratio = base > 0.5 ? cur / base : (cur >= 3 ? 99 : 0);
      out.push({
        key: `tone:${q.tag}:${pts.at(-1)[0]}`, ts: pts.at(-1)[0],
        title: `「${q.tag}」报道量 ${base.toFixed(1)} → ${cur.toFixed(1)} 篇/桶（${ratio >= 99 ? '从无到有' : ratio.toFixed(2) + '×'}，峰值 ${Math.max(...pts.map(p => p[1]))}）`,
        tags: ['gdelt-timeline', q.tag, ratio >= 1.8 ? '升温' : ratio <= 0.55 ? '降温' : '平稳'].filter(Boolean),
        weight: +Math.min(6, 1 + ratio).toFixed(2), ttl: 86400,
        meta: { query: q.q, baseline: +base.toFixed(2), current: +cur.toFixed(2), ratio: +ratio.toFixed(2),
                peak: Math.max(...pts.map(p => p[1])), buckets: pts.length, series: pts.map(p => p[1]) },
      });
    } catch (e) {
      failed.push(`${q.tag}: ${e.message.slice(0, 80)}`);
      log?.(`  ! gdelt_timeline/${q.tag}: ${e.message}`);
      if (e.ratelimited) { limited = true; await sleep(30_000); break }
    }
  }
  return {
    events: out,
    note: out.length
      ? (failed.length ? `${failed.length}/${(source.queries || []).length} 个查询失败：${failed[0]}` : null)
      : `0 条：${limited ? '撞上 GDELT 限速（已中止本轮）' : failed[0] || '无数据'}`,
  };
}

/** DOC API：按查询取文章列表（标题+链接）。无坐标，只进事件流不进地图。 */
export async function gdelt_doc({ source, log }) {
  const out = [];
  const failed = [];
  for (const q of source.queries || []) {
    const params = new URLSearchParams({
      query: q.q, mode: 'ArtList', format: 'json', maxrecords: String(source.maxrecords || 20),
      timespan: source.timespan || '2h', sort: 'dateevent',
    });
    if (out.length || failed.length) await sleep(GAP_MS);
    try {
      const j = await raw(`${source.url}?${params}`);
      for (const a of j.articles || []) {
        out.push({
          key: `doc:${a.url}`, ts: isodate(String(a.seendate)) || Math.floor(Date.now() / 1000),
          title: a.title, url: a.url,
          tags: ['gdelt-doc', q.tag, a.language].filter(Boolean),
          weight: 1, ttl: 86400 * 7,
          meta: { domain: a.domain, query: q.tag, language: a.language, image: a.socialimage || null },
        });
      }
    } catch (e) {
      failed.push(`${q.tag}: ${e.message.slice(0, 80)}`);
      log?.(`  ! gdelt_doc/${q.tag}: ${e.message}`);
      if (e.ratelimited) break;
    }
  }
  return { events: out, note: out.length ? (failed.length ? `${failed.length} 个查询失败：${failed[0]}` : null) : `0 条：${failed[0] || '无匹配文章'}` };
}
