// 经济 / 市场 / 制裁
import { get, HttpError } from '../http.mjs';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const iso = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? Math.floor(t / 1000) : null };

/** CoinGecko /simple + /markets（免费档限速严格，只当补充，不当行情主源） */
export async function coingecko({ source }) {
  const ids = process.env.COINGECKO_IDS || 'bitcoin,ethereum,solana';
  const d = await get(`${source.url}?vs_currency=usd&ids=${ids}&price_change_percentage=24h,7d`, { ttl: 120 });
  const now = Math.floor(Date.now() / 1000);
  const minMove = source.min_move_pct ?? 3;
  const out = [];
  for (const c of d || []) {
    const ch = Number(c.price_change_percentage_24h) || 0;
    const m = {
      price: c.current_price, ch24: +ch.toFixed(2),
      ch7d: c.price_change_percentage_7d_in_currency != null ? +Number(c.price_change_percentage_7d_in_currency).toFixed(2) : null,
      market_cap: c.market_cap, volume: c.total_volume, ath: c.ath, ath_change: c.ath_change_percentage,
    };
    if (Math.abs(ch) >= minMove) {
      out.push({
        key: `cg:${c.id}:${Math.floor(now / 300)}`, ts: now,
        title: `${c.symbol.toUpperCase()} ${ch > 0 ? '急涨' : '急跌'} ${ch.toFixed(2)}% → $${Number(c.current_price).toLocaleString('en-US')}`,
        tags: ['crypto', c.id, Math.abs(ch) >= 8 ? 'sharp-move' : 'move'].filter(Boolean),
        weight: 1 + Math.min(4, Math.abs(ch) / 3), ttl: 3600, meta: m,
      });
    }
    // 无论涨跌都留一份水位，给右侧时间线用（kind=market 但 weight 很低，不进地图）
    out.push({
      key: `cgq:${c.id}:${Math.floor(now / 300)}`, ts: now, kind: 'market',
      title: `${c.symbol.toUpperCase()} 水位 $${Number(c.current_price).toLocaleString('en-US')}（24h ${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%）`,
      tags: ['crypto-quote', c.id], weight: 0.4, ttl: 900, meta: { ...m, quote_only: true },
    });
  }
  const moves = out.filter(x => !x.tags.includes('crypto-quote')).length;
  return { events: out, note: moves ? null : `无标的超过 ±${minMove}%（当前波动：${(d || []).map(c => `${c.symbol} ${Number(c.price_change_percentage_24h || 0).toFixed(1)}%`).join('、')}）` };
}

/**
 * 世行宏观指标：无 key、无速率惩罚、年度更新。
 * 它的价值不是「实时」，而是给地图提供一层可对质的基本面底色（债务/增速/经常账户）。
 */
const WB_INDICATORS = {
  'NY.GDP.MKTP.KD.ZG': ['GDP 增速', '%', 1],
  'FP.CPI.TOTL.ZG':    ['CPI 通胀', '%', 1.2],
  'GC.DOD.TOTL.GD.ZS': ['政府债务/GDP', '%', 1.1],
  'BN.CAB.XOKA.GD.ZS': ['经常账户/GDP', '%', 1],
  'PA.NUS.FCRF':       ['官方汇率(本币/USD)', '', 0.6],
  'SP.POP.TOTL':       ['人口', '', 0.4],
};

export async function worldbank({ source, log }) {
  const codes = (process.env.WB_COUNTRIES || 'USA,CHN,DEU,JPN,IND,RUS,BRA,GBR,FRA,ITA,KOR,TUR,SAU,IDN,MEX,ZAF,EGY,IRN,UKR,POL,PAK,VNM,THA,NLD,CAN,AUS,ARG,DZA,NGA,EGY')
    .split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  const errors = [];
  for (const [code, [name, unit, weight]] of Object.entries(WB_INDICATORS)) {
    try {
      const d = await get(`${source.url}/country/${codes.join(';')}/indicator/${code}?format=json&date=2015:2026&per_page=400`, { ttl: 86400 });
      const rows = (d[1] || []).filter(r => r.value !== null && r.countryiso3code);
      const latest = new Map();
      for (const r of rows) {
        const prev = latest.get(r.countryiso3code);
        if (!prev || r.date > prev.date) latest.set(r.countryiso3code, r);
      }
      for (const [c, r] of latest) {
        out.push({
          key: `wb:${code}:${c}:${r.date}`,
          ts: Math.floor(Date.parse(`${r.date}-06-30`) / 1000),
          title: `${r.country?.value || c} ${name} ${Number(r.value).toFixed(2)}${unit} (${r.date})`,
          tags: ['worldbank', code, c], weight, ttl: 86400 * 400,
          meta: { indicator: code, indicator_name: name, country: c, value: r.value, year: r.date },
        });
      }
    } catch (e) { errors.push(`${code}: ${e.message}`); log?.(`  ! worldbank/${code}: ${e.message}`) }
  }
  return {
    events: out,
    note: out.length
      ? (errors.length ? `${Object.keys(WB_INDICATORS).length - errors.length}/${Object.keys(WB_INDICATORS).length} 个指标成功，失败：${errors[0]}` : null)
      : `${Object.keys(WB_INDICATORS).length} 个指标全部失败：${errors[0] || '无数据'} —— 是抓取失败，不是「没有宏观数据」`,
  };
}

/** UN Comtrade：preview 端点免 key（有额度与字段限制）；配 COMTRADE_KEY 可放宽 */
export async function comtrade({ source, log }) {
  const key = process.env.COMTRADE_KEY;
  // 只测过的最小参数集：加 customsCode / motCode 会被判 Invalid parameter value
  const cmds = (process.env.COMTRADE_CODES || '8542:半导体,2709:原油,3105:化肥,8708:汽车零部件,7108:黄金').split(',');
  const out = [];
  const errors = [];
  for (const spec of cmds) {
    const [cmd, label] = spec.split(':');
    try {
      const params = new URLSearchParams({
        reporterCode: process.env.COMTRADE_REPORTER || '156', partnerCode: '0',
        period: process.env.COMTRADE_PERIOD || '2024', categoryCode: cmd, flowCode: 'X',
        ...(key ? { subscriptionKey: key } : {}),
      });
      const d = await get(`${source.url}?${params}`, { ttl: 86400 });
      if (d.error) { log?.(`  ! comtrade/${cmd}: ${d.error}${d.details?.[0] ? ' (' + d.details[0].MemberNames + ')' : ''}`); continue }
      for (const r of (d.data || []).slice(0, 3)) {
        out.push({
          key: `comtrade:${r.reporterCode}:${r.cmdCode}:${r.flowCode}:${r.refPeriodId}:${r.partnerCode}`,
          ts: yyyymm(r.refPeriodId) || Math.floor(Date.now() / 1000),
          title: `中国 HS${r.cmdCode}${label ? ' ' + label : ''} 出口 $${(r.primaryValue / 1e9).toFixed(1)}B（${r.refPeriodId} → ${r.partnerDesc || '世界'}）`,
          tags: ['comtrade', `hs${r.cmdCode}`, label].filter(Boolean), weight: 1.2, ttl: 86400 * 400,
          meta: { cmd: r.cmdCode, cmdDesc: r.cmdDesc, value_usd: r.primaryValue, period: r.refPeriodId, partner: r.partnerDesc },
        });
      }
    } catch (e) { errors.push(`${cmd}: ${e.message}`); log?.(`  ! comtrade/${cmd}: ${e.message}`) }
  }
  return {
    events: out,
    note: out.length
      ? (errors.length ? `${cmds.length - errors.length}/${cmds.length} 个编码成功，失败：${errors[0]}` : null)
      : `${cmds.length} 个编码全部失败：${errors[0] || '返回空 data（preview 端点额度或参数被拒）'}`,
  };
}
const yyyymm = (s) => {
  const m = /^(\d{4})(\d{2})$/.exec(String(s || ''));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, 15) / 1000) : null;
};


/**
 * OFAC SDN 全量约 29MB —— 不能每 5 分钟拉。
 * 做法：拉一次 → 算内容指纹 → 只有指纹变了才产出一条「名单变化」事件。
 * 事件里带记录数与指纹，你就能知道「今天名单动了没有」，而不用存 29MB。
 */
export async function ofac({ source, log }) {
  const dir = join(process.cwd(), 'data');
  mkdirSync(dir, { recursive: true });
  const fpFile = join(dir, 'ofac-fingerprint.json');
  let prev = null;
  try { prev = JSON.parse(readFileSync(fpFile, 'utf8')) } catch {}

  const res = await fetch(source.url, { headers: { 'user-agent': 'intelmap/0.1 (personal dashboard)' } });
  if (!res.ok) throw new HttpError(`OFAC HTTP ${res.status}`, { status: res.status, url: source.url });
  const text = await res.text();
  const records = (text.match(/<sdn>/g) || []).length;
  const sha = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const fp = Buffer.from(sha).toString('hex').slice(0, 16);
  if (prev?.fp === fp) { log?.('  · ofac: 指纹未变'); return [] }
  writeFileSync(fpFile, JSON.stringify({ fp, records, at: Date.now() }));
  return [{
    key: `ofac:${fp}`, ts: Math.floor(Date.now() / 1000),
    title: `OFAC SDN 名单变化：${records.toLocaleString('en-US')} 条记录（前值 ${prev?.records?.toLocaleString('en-US') ?? '基线'}）`,
    url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
    tags: ['ofac', 'sanctions', prev ? 'changed' : 'baseline'],
    weight: prev ? 3.5 : 1, ttl: 86400 * 40,
    meta: { records, fingerprint: fp, previous_records: prev?.records ?? null, mb: +(text.length / 1048576).toFixed(1) },
  }];
}

/** OpenSanctions：聚合 400+ 名单，看哪些数据集在更新（轻量元数据，不拉实体） */
export async function opensanctions({ source }) {
  const d = await get(source.url, { ttl: 3600 });
  const list = d.datasets || [];
  const hit = list.filter(x => /sanction|pep|debar|watchlist|ofac|eu_|un_|worldbank/i.test([x.name, x.title, x.collection].join(' ')));
  return hit
    .filter(x => x.updated_at)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, 14)
    .map(x => ({
      key: `os:${x.name}:${x.updated_at}`,
      ts: iso(x.updated_at) || Math.floor(Date.now() / 1000),
      title: `${x.title || x.name}：${(x.entity_count ?? x.extents?.entities ?? 0).toLocaleString('en-US')} 实体，更新于 ${String(x.updated_at).slice(0, 10)}`,
      url: `https://www.opensanctions.org/datasets/${x.name}/`,
      tags: ['opensanctions', x.collection, x.publisher?.publishable ? 'publishable' : null].filter(Boolean),
      weight: 1.5, ttl: 86400 * 40,
      meta: { name: x.name, entities: x.entity_count, publisher: x.publisher?.name, license: x.publisher?.official || x.publisher?.url },
    }));
}
