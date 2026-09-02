// 统一事件信封。所有适配器必须吐出这个形状 —— 全项目最重要的一条约定。
import { createHash } from 'node:crypto';

export const KINDS = {
  disaster:  { color: '#ff6b6b', label: '灾害' },
  conflict:  { color: '#f4a259', label: '冲突' },
  aircraft:  { color: '#4cc9f0', label: '航空器' },
  vessel:    { color: '#7bdff2', label: '船舶' },
  news:      { color: '#e85d9a', label: '新闻事件' },
  signal:    { color: '#ffd166', label: '信号' },
  market:    { color: '#06d6a0', label: '市场' },
  macro:     { color: '#8d99ae', label: '宏观' },
  trade:     { color: '#f9c74f', label: '贸易' },
  sanctions: { color: '#e76f51', label: '制裁' },
  spacewx:   { color: '#a06cd5', label: '空间天气' },
  weather:   { color: '#5bc0be', label: '天气' },
};

export function hashId(...parts) {
  return createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 20);
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * @param {object} s  源定义（来自 sources.json）
 * @param {object} p  适配器产出的原始事件
 */
export function makeEvent(s, p) {
  const lat = Number.isFinite(p.lat) ? p.lat : null;
  const lon = Number.isFinite(p.lon) ? p.lon : null;
  const t = now();
  const ts = Math.floor(p.ts || t);
  return {
    id: p.id || hashId(s.id, p.key ?? p.title ?? `${lat},${lon},${p.ts ?? ''}`),
    source: s.id,
    kind: p.kind || s.kind,
    // 上游时间戳偶尔会跑到未来（GDELT 的 DATEADDED 就是），夹住，否则「N 分钟前」会显示成负数
    ts: Math.min(ts, t + 900),
    ingest_ts: t,
    lat,
    lon,
    title: String(p.title || '').slice(0, 400),
    body: String(p.body || '').slice(0, 2000),
    url: p.url || null,
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 12) : [],
    weight: Number.isFinite(p.weight) ? p.weight : 1,
    ttl: p.ttl ?? s.ttl ?? 86400,
    region: p.region || null,
    meta: p.meta || {},
  };
}

export const isLive = (e, at = now()) => e.ingest_ts + e.ttl > at;

/** bbox = [w,s,e,n]；无坐标的事件不参与地图渲染，但仍进事件流 */
export function inBbox(e, bbox) {
  if (!bbox) return true;
  if (e.lat == null || e.lon == null) return false;
  const [w, s, ea, n] = bbox;
  return e.lon >= w && e.lon <= ea && e.lat >= s && e.lat <= n;
}
