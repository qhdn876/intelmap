// 自然灾害 / 气候 / 空间天气
import { get } from '../http.mjs';

const iso = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? Math.floor(t / 1000) : null };

/** USGS 地震 feed（GeoJSON，公共领域，无 key）。url 决定切片：2.5_day / all_hour / significant_month … */
export async function usgs_quakes({ source }) {
  const d = await get(source.url, { ttl: 120 });
  return (d.features || [])
    .filter(f => Number.isFinite(f.geometry?.coordinates?.[1]))
    .map(f => ({
      key: f.id,
      ts: Math.floor((f.properties?.time || 0) / 1000),
      lat: f.geometry.coordinates[1],
      lon: f.geometry.coordinates[0],
      title: `M${(f.properties?.mag ?? 0).toFixed(1)} · ${f.properties?.place || '未知位置'}`,
      url: f.properties?.url || null,
      tags: ['quake', f.properties?.type || 'earthquake',
             Number(f.properties?.mag) >= 6 ? 'm6plus' : null,
             f.properties?.tsunami ? 'tsunami-alert' : null].filter(Boolean),
      // 震级映射到视觉权重：5.0→2.5，7.0→4.5；再叠加有感人数
      weight: Math.max(0.6, (f.properties?.mag || 3) - 2.5) * (f.properties?.felt > 500 ? 1.4 : 1),
      ttl: 172800,
      meta: { mag: f.properties?.mag, depth_km: f.geometry.coordinates[2], felt: f.properties?.felt,
              mmi: f.properties?.mmi, status: f.properties?.status, place: f.properties?.place },
    }));
}

/** NASA EONET v3：自然灾害实时事件（含 wildfire/storm/seaice 等），坐标取几何最后一个点=最新位置 */
export async function eonet({ source }) {
  const d = await get(source.url, { ttl: 900 });
  const W = { wildfires: 2, storms: 3, volcanoes: 2.5, floods: 2, droughts: 1.6,
              landslides: 1.5, 'severe storms': 3, dust: 1, 'sea ice': 1, lakes: 1, mass: 1.5 };
  return (d.events || []).map(ev => {
    const g = ev.geometry?.[ev.geometry.length - 1];
    if (!g?.coordinates) return null;
    const cat = ev.categories?.[0]?.id || 'event';
    return {
      key: `eonet:${ev.id}`,
      ts: iso(g.date) || iso(ev.date) || Math.floor(Date.now() / 1000),
      lat: g.coordinates[1], lon: g.coordinates[0],
      title: `${ev.title} · ${cat}`,
      url: ev.link?.[0]?.href || null,
      tags: ['eonet', cat, ...(ev.categories || []).map(c => c.group).filter(Boolean)],
      weight: W[cat] ?? 1.5,
      ttl: 604800,
      meta: { link: ev.link?.[0]?.href || null, categories: ev.categories?.map(c => c.title), geo_count: ev.geometry?.length },
    };
  }).filter(Boolean);
}

/** NOAA SWPC：耀斑（X 射线流量）与地磁 Kp。影响卫星/通信/GPS，是「基础设施扰动」里常被忽略的一条。 */
export async function swpc_spacewx({ source }) {
  const [xr, kp] = await Promise.all([
    get(source.url, { ttl: 300 }).catch(() => []),
    get('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', { ttl: 300 }).catch(() => []),
  ]);
  const out = [];
  const flares = (xr || []).filter(x => Number(x.flux) >= 1000);        // M 级以上
  const top = flares.sort((a, b) => Number(b.flux) - Number(a.flux))[0];
  if (top) out.push({
    key: `flare-${top.time_tag}`, ts: iso(top.time_tag) || Math.floor(Date.now() / 1000),
    title: `太阳耀斑活动：X 射线通量 ${(Number(top.flux) / 1e-6).toExponential(1)} pW/m²（${Number(top.flux) >= 1e5 ? 'X' : 'M'} 级）`,
    kind: 'spacewx', tags: ['solar', 'flare', Number(top.flux) >= 1e5 ? 'x-class' : 'm-class'],
    weight: Number(top.flux) >= 1e5 ? 4 : 2.4, ttl: 86400,
    meta: { flux: top.flux, satellite: top.satellite, observations: flares.length },
  });
  const k = (kp || []).at(-1);
  if (k && Number(k.Kp) >= 6) out.push({
    key: `kp-${k.time_tag}`, ts: iso(k.time_tag) || Math.floor(Date.now() / 1000),
    title: `地磁暴：Kp=${k.Kp}`, kind: 'spacewx', tags: ['geomagnetic'],
    weight: Number(k.Kp) / 2.5, ttl: 86400, meta: { Kp: k.Kp },
  });
  const maxFlare = (xr || []).reduce((m, x) => Math.max(m, Number(x.flux) || 0), 0);
  const maxKp = (kp || []).reduce((m, x) => Math.max(m, Number(x.Kp) || 0), 0);
  return { events: out, note: out.length ? null
    : `太阳平静：峰值通量 ${maxFlare.toExponential(1)} < M1000，Kp ${maxKp.toFixed(1)} < 6` };
}

// MET Norway：按城市表扫描，只上报越过阈值的（极端天气是「发生」而非「预报」才有情报价值）
const CITIES = [
  ['基辅', 50.45, 30.52], ['莫斯科', 55.75, 37.62], ['华沙', 52.23, 21.01], ['柏林', 52.52, 13.4],
  ['安卡拉', 39.93, 32.86], ['雅典', 37.98, 23.72], ['布加勒斯特', 44.43, 26.1], ['赫尔辛基', 60.17, 24.94],
  ['北京', 39.9, 116.4], ['东京', 35.68, 139.69], ['首尔', 37.57, 126.98], ['台北', 25.03, 121.57],
  ['新德里', 28.61, 77.21], ['伊斯兰堡', 33.68, 73.05], ['德黑兰', 35.7, 51.4], ['开罗', 30.04, 31.24],
  ['拉各斯', 6.52, 3.38], ['内罗毕', -1.29, 36.82], ['比勒陀利亚', -25.75, 28.19], ['里约', -22.91, -43.17],
  ['圣保罗', -23.55, -46.63], ['墨西哥城', 19.43, -99.13], ['渥太华', 45.42, -75.7], ['华盛顿', 38.9, -77.03],
  ['堪培拉', -35.28, 149.13], ['雅加达', -6.2, 106.85], ['马尼拉', 14.6, 120.98], ['河内', 21.03, 105.85],
];

/** MET Norway locationforecast（免费，硬性要求标识性 User-Agent，且 UA 里不能带 email 字样） */
export async function metno_sweep({ source, log }) {
  const out = [];
  let okCities = 0;
  const errors = new Map();
  for (const [name, lat, lon] of CITIES) {
    const url = `${source.url}?lat=${lat}&lon=${lon}&altitude=30`;
    try {
      const d = await get(url, { ttl: 3600, timeout: 12000 });
      okCities++;
      const times = (d.properties?.timeseries || []).slice(0, 24);
      if (!times.length) continue;
      let maxWind = 0, maxT = -Infinity, minT = Infinity, rain = 0;
      for (const t of times) {
        const i = t.data?.instant?.details || {};
        const n1 = t.data?.next_1_hours?.details || {};
        maxWind = Math.max(maxWind, i.wind_speed || 0);
        if (Number.isFinite(i.air_temperature)) { maxT = Math.max(maxT, i.air_temperature); minT = Math.min(minT, i.air_temperature) }
        rain += n1.precipitation_amount || 0;
      }
      const flags = [
        maxWind >= 24.5 && '风暴', maxWind >= 17.2 && maxWind < 24.5 && '大风',
        maxT >= 38 && '高温', minT <= -18 && '低温', rain >= 60 && '强降水',
      ].filter(Boolean);
      if (!flags.length) continue;
      out.push({
        key: `metno:${name}:${flags.join('/')}:${times[0].time}`,
        ts: Math.floor(Date.parse(times[0].time) / 1000) || Math.floor(Date.now() / 1000),
        lat, lon,
        title: `${name} · ${flags.join('/')}（阵风 ${maxWind.toFixed(0)}m/s，${Number.isFinite(minT) ? minT.toFixed(0) : '?'}~${Number.isFinite(maxT) ? maxT.toFixed(0) : '?'}°C，24h 降水 ${rain.toFixed(0)}mm）`,
        tags: ['metno', ...flags], weight: 1.5 + flags.length, ttl: 86400,
        meta: { max_wind: +maxWind.toFixed(1), t_min: +minT.toFixed(1), t_max: +maxT.toFixed(1), rain_24h: +rain.toFixed(1) },
      });
    } catch (e) {
      const k = `${e.status || 'ERR'} ${e.message}`.replace(/[^ ]*$/, '').trim() || e.message;
      errors.set(k, (errors.get(k) || 0) + 1);
      log?.(`  ! metno/${name}: ${e.message}`);
    }
  }
  // 区分「问到了，确实没超标」和「根本没问到」—— 后者绝不能报成「无异常」
  const errSummary = [...errors.entries()].map(([k, n]) => `${k}×${n}`).join(', ');
  if (okCities === 0) {
    return { events: [], note: `全部 ${CITIES.length} 个城市抓取失败（${errSummary}）——这是故障，不是「无极端天气」` };
  }
  return {
    events: out,
    note: out.length
      ? (okCities < CITIES.length ? `${okCities}/${CITIES.length} 城市成功，失败：${errSummary}` : null)
      : `${okCities}/${CITIES.length} 城市均未越阈值（阵风<17.2m/s、-18°C<T<38°C、24h降水<60mm）`,
  };
}
