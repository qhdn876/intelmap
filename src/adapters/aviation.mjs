// 航空 / 冲突
import { get, HttpError } from '../http.mjs';

const iso = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? Math.floor(t / 1000) : null };

/**
 * OpenSky：匿名可调，但限额低（注册免费 client_id/secret 后用 Basic 认证放宽）。
 * 关键点：它要求 bounding box，全球全量拉不动 —— 所以按 regions 分次抓。
 * 单架飞机不是事件；「某区域航空器密度的时间变化」才是信号，所以这里既产点也产聚合。
 */
export async function opensky({ source, bboxIndex = 0, log }) {
  const regions = source.regions || [];
  const region = regions[bboxIndex];
  if (!region) return [];
  const [w, s, ea, n] = region.bbox;
  const url = `${source.url}?lamin=${s}&lomin=${w}&lamax=${n}&lomax=${ea}`;
  const auth = process.env.OPENSKY_CLIENT_ID
    ? { Authorization: 'Basic ' + Buffer.from(`${process.env.OPENSKY_CLIENT_ID}:${process.env.OPENSKY_CLIENT_SECRET || ''}`).toString('base64') }
    : {};
  const d = await get(url, { ttl: 240, timeout: 25000, headers: auth });
  const states = d.states || [];
  const stamp = Number(d.time) || Math.floor(Date.now() / 1000);

  // 区域聚合信号：按 2°×2° 网格统计，只报密度显著高于该区历史均值的格子
  const cells = new Map();
  for (const x of states) {
    if (!Number.isFinite(x[6]) || !Number.isFinite(x[5])) continue;
    const key = `${Math.floor(x[6] / 2) * 2},${Math.floor(x[5] / 2) * 2}`;
    const c = cells.get(key) || { n: 0, lat: 0, lon: 0 };
    c.n++; c.lat += x[6]; c.lon += x[5];
    cells.set(key, c);
  }
  const dense = [...cells.entries()].filter(([, c]) => c.n >= (source.dense_min || 12))
    .sort((a, b) => b[1].n - a[1].n).slice(0, 12);

  const out = dense.map(([key, c]) => ({
    key: `skydens:${region.name}:${key}:${Math.floor(stamp / 900)}`,
    ts: stamp, lat: c.lat / c.n, lon: c.lon / c.n,
    title: `${region.name} 空域密集格 ${key}：${c.n} 架在飞`,
    tags: ['air-density', region.name], weight: Math.min(6, 1 + c.n / 12), ttl: 3600,
    meta: { aircraft: c.n, region: region.name, cell: key, total_in_region: states.length },
  }));

  // 特别关注：军机/政府机注册国 + 无 callsign 广播（不等于可疑，只是值得看一眼的线索）
  const mil = (process.env.OPENSKY_MILITARY_PREFIXES || 'KM,RMM,RAFR,NAVY,ARMY,VLEN,DAL').split(',');
  for (const x of states) {
    const cs = (x[1] || '').trim();
    if (!cs || !mil.some(p => cs.startsWith(p))) continue;
    if (!Number.isFinite(x[6]) || !Number.isFinite(x[5])) continue;
    out.push({
      key: `skymil:${x[0]}:${Math.floor(stamp / 600)}`, ts: stamp, lat: x[6], lon: x[5],
      title: `${cs} · ${x[2]} · ${Math.round((x[9] || 0) * 3.6)}km/h @ ${Math.round((x[14] || 0) * 3.281)}ft`,
      tags: ['aircraft', 'preset-prefix', region.name], weight: 2.2, ttl: 3600,
      meta: { icao24: x[0], callsign: cs, country: x[2], velocity: x[9], baro_altitude: x[14], squawk: x[7] },
    });
  }
  log?.(`  · opensky/${region.name}: ${states.length} 架次 → ${out.length} 条`);
  return {
    events: out,
    note: out.length ? null : `${region.name} 共 ${states.length} 架次，但没有网格达到 dense_min=${source.dense_min || 12} 且无匹配前缀的军机`,
  };
}

/** ACLED：非商用免费注册账号。没配 key 时 registry 已把源禁用，这里只是防御性检查。 */
export async function acled({ source }) {
  if (!process.env.ACLED_EMAIL || !process.env.ACLED_PASSWORD) return [];
  const tok = await get(`https://api.acleddata.com/oauth/external/token?grant_type=client_credentials&email=${encodeURIComponent(process.env.ACLED_EMAIL)}&password=${encodeURIComponent(process.env.ACLED_PASSWORD)}`);
  if (!tok.access_token) throw new HttpError('ACLED 未返回 access_token（检查账号或 IP 白名单）', { url: 'acleddata' });
  const where = encodeURIComponent(JSON.stringify({ sampledate: source.window || '7 Day' }));
  const d = await get(`https://api.acleddata.com/acled/read?version=2&limit=1000&sort=sampledate&sort_dir=DESC&where=${where}`,
    { headers: { Authorization: `Bearer ${tok.access_token}` }, raw: true });
  const j = JSON.parse(d);
  return (j.data || []).map(r => ({
    key: `acled:${r.id}`, ts: iso(`${r.sampledate || r.event_date} 12:00:00Z`),
    lat: Number(r.latitude) || null, lon: Number(r.longitude) || null,
    title: `${{ 1: '战斗', 2: '非交战方袭击', 3: '暴力骚乱' }[r.type_of_violence] || '暴力事件'} · ${r.country_name}${r.admin1_name ? ' · ' + r.admin1_name : ''} · ${r.fatalities ?? 0} 人死亡`,
    tags: ['acled', r.side_a1 || '', r.side_a2 || ''].filter(Boolean),
    weight: Math.min(6, 1 + Math.log10(1 + Number(r.fatalities || 0)) * 2),
    ttl: 86400 * 40,
    meta: { type: r.type_of_violence_name, fatalities: r.fatalities, actor_a: r.side_a1_name, actor_b: r.side_a2_name, region: r.country_name },
  })).filter(e => e.ts);
}

/** UCDP：研究用免费 token */
export async function ucdp({ source }) {
  if (!process.env.UCDP_TOKEN) return [];
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 14 * 86400e3).toISOString().slice(0, 10);
  const d = await get(`https://ucdpapi.pcrs.uu.se/encedc/api/events?json=true&high=1&verbose=1&_token=${process.env.UCDP_TOKEN}&from_date=${from}&to_date=${to}&pagesize=800`);
  return (d._embedded?.encasedconflictdtoList || []).map(r => ({
    key: `ucdp:${r.id}`, ts: iso(`${r.date_start} 12:00:00Z`),
    lat: Number(r.latitude) || null, lon: Number(r.longitude) || null,
    title: `${r.type_of_violence_name || '事件'} · ${r.country}${r.location_geo_name ? ' · ' + r.location_geo_name : ''} · 死亡 ${r.deaths_other ?? r.deaths_best ?? '?'}`,
    tags: ['ucdp', r.region || '', `rel${r.relation_to_territory_settled || ''}`].filter(Boolean),
    weight: Math.min(6, 1 + Math.log10(1 + Number(r.deaths_best || r.deaths_other || 0)) * 2),
    ttl: 86400 * 40,
    meta: { deaths: r.deaths_best, actor_a: r.actor1_name, actor_b: r.actor2_name, issue: r.issue },
  })).filter(e => e.ts);
}
