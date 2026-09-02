// 非轮询源（流式）的占位约定。
// 轮询模型（interval + fetch）套不住 WebSocket 常连，硬塞只会让调度器变复杂。
// 正确做法：单独起一个进程长连，往同一个 store 里 insertMany —— 前端一行都不用改。
import { store } from '../store.mjs';
import { makeEvent } from '../envelope.mjs';

export function aisstream_ws() {
  return { events: [], note: '流式源：跑 `node src/adapters/stream.mjs --serve`，它长连 aisstream.io 并直接写入同一个事件库' };
}

/**
 * AIS 长连侧进程。需要 AISSTREAM_KEY（免费注册）。
 * 用法： AISSTREAM_KEY=xxx node src/adapters/stream.mjs --serve
 *
 * 许可注意：aisstream 条款不允许长期留存衍生数据，所以这里 ttl 只有 15 分钟，
 * 且同一 MMSI 10 分钟内只保留一条 —— 看「此刻谁在苏伊士」够用，攒历史别用它。
 */
async function serve() {
  const key = process.env.AISSTREAM_KEY;
  if (!key) { console.error('[ais] 缺少 AISSTREAM_KEY'); process.exit(1) }
  const source = { id: 'aisstream', kind: 'vessel', ttl: 900 };
  const watches = (process.env.AIS_WATCH || '30.5,32.3:苏伊士;26.5,56.5:霍尔木兹;1.2,103.8:新加坡')
    .split(';').map(s => { const [c, name] = s.split(':'); const [lat, lon] = c.split(','); return { name, lat: +lat, lon: +lon } });

  const ws = new WebSocket('wss://stream.aisstream.io/v0/names');
  const seen = new Map();
  ws.onopen = async () => {
    const names = await (await fetch('https://stream.aisstream.io/v1/names', {
      headers: { Authorization: `Bearer ${key}` } })).json().catch(() => null);
    console.log('[ais] 可用区域组:', names?.Message?.join(', ') || '(拉取失败)');
    ws.send(JSON.stringify({
      APIKey: key,
      BoundingBoxes: watches.map(w => [[w.lat - 1.5, w.lon - 1.5], [w.lat + 1.5, w.lon + 1.5]]),
      FilterMessageTypes: ['positionReport'],
    }));
    console.log('[ais] 已订阅:', watches.map(w => w.name).join(', '));
  };
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    const p = m?.Message?.PositionReport; if (!p) return;
    const lat = p.Position?.Latitude, lon = p.Position?.Longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const id = p.Meta?.MMSI; if (!id) return;
    const ts = p.Meta?.Timestamp || Math.floor(Date.now() / 1000);
    if (seen.has(id) && ts - seen.get(id) < 600) return;
    seen.set(id, ts);
    const near = watches.find(w => Math.abs(w.lat - lat) < 1.6 && Math.abs(w.lon - lon) < 1.6);
    store.insertMany([makeEvent(source, {
      key: `ais:${id}:${Math.floor(ts / 600)}`, ts, lat, lon,
      title: `${p.ShipName?.trim() || id} · ${p.ShipType?.Description || '船'} · ${Math.round((p.SOG || 0) * 1.852)}km/h${p.ShipType?.Cargo ? ' · 危险品' : ''}`,
      tags: ['ais', near?.name, p.ShipType?.Cargo ? 'cargo-tanker' : null, p.ShipType?.Passengers ? 'passenger' : null].filter(Boolean),
      weight: p.ShipType?.Cargo ? 2.6 : 1.2, ttl: 900,
      meta: { mmsi: id, name: p.ShipName, type: p.ShipType?.Description, sog: p.SOG, cog: p.COG,
              nav_status: p.NavStatus?.Description, dest: p.Destination, zone: near?.name || null },
    })]);
  };
  ws.onerror = (e) => console.error('[ais] WS 错误', e?.message || e);
  ws.onclose = () => { console.log('[ais] 断开，5s 后重连'); setTimeout(() => serve(), 5000) };
  setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    for (const [k, t] of seen) if (now - t > 3600) seen.delete(k);
  }, 600_000).unref?.();
}

if (process.argv[2] === '--serve') await serve();
