// 调度与抓取：一轮只跑「到期」的源；失败退避；全局并发闸。
//
// 约定：适配器可以返回数组，也可以返回 { events, note }。
// note 用来回答「为什么是 0 条」—— 是源坏了，还是本来就没过阈值。
// 静默返回 0 是最难调试的东西，宁可啰嗦。
import { store } from './store.mjs';
import { makeEvent } from './envelope.mjs';
import { backoffFor, sleep } from './http.mjs';

const MAX_PAR = Number(process.env.MAX_PARALLEL || 2);
const urlOf = (s) => String(s.url || '').split('?')[0];

function normalizeReturn(r) {
  if (Array.isArray(r)) return { events: r, note: r.length ? null : '适配器返回空数组（未给原因）' };
  return { events: r?.events || [], note: r?.note ?? null };
}

/** 跑一轮。only=['usgs_quakes'] 时只跑指定源；force 忽略到期判断。 */
export async function runCycle(registry, { only = null, force = false, log = console.log } = {}) {
  const now = Date.now();
  const due = registry.sources.filter(s => {
    if (!s.runnable) return false;
    if (only?.length && !only.includes(s.id)) return false;
    if (force) return true;
    const h = store.health.get(s.id);
    if (!h?.last_run) return true;
    return now - h.last_run >= s.interval * 1000 && now - h.last_run >= backoffFor(urlOf(s));
  });

  if (!due.length) return { ran: 0, added: 0, failed: 0, results: [], next: nextWake(registry) };

  log(`[ingest] ${due.length} 个源到期: ${due.map(s => s.id).join(', ')}`);
  const results = [];
  const queue = [...due];

  await Promise.all(Array.from({ length: Math.min(MAX_PAR, queue.length) }, async () => {
    while (queue.length) {
      const s = queue.shift();
      const t0 = Date.now();
      try {
        const { events: raw, note } = normalizeReturn(await s.fn({ source: s, registry, log, bboxIndex: 0 }));
        const events = raw.map(p => makeEvent(s, p));
        const added = store.insertMany(events);
        const ms = Date.now() - t0;
        store.markRun(s.id, { ok: true, count: events.length, added, ms, note });
        results.push({ id: s.id, ok: true, got: events.length, added, ms, note });
        log(`  ok   ${s.id.padEnd(20)} 取回 ${String(events.length).padStart(5)} 新增 ${String(added).padStart(4)} ${String(ms).padStart(6)}ms${note ? '  ' + note : ''}`);
      } catch (e) {
        const ms = Date.now() - t0;
        store.markRun(s.id, { ok: false, error: `${e.status || ''} ${e.message}`.trim(), ms });
        results.push({ id: s.id, ok: false, error: e.message, ms });
        log(`  FAIL ${s.id.padEnd(20)} ${e.message}`);
      }
      await sleep(400);                       // 别把某个免费源连着打死
    }
  }));

  return {
    ran: results.length,
    added: results.reduce((s, r) => s + (r.added || 0), 0),
    failed: results.filter(r => !r.ok).length,
    zero_but_ok: results.filter(r => r.ok && !r.got).map(r => ({ id: r.id, note: r.note })),
    results,
    next: nextWake(registry),
  };
}

/** 下一轮等多久：最近的到期时间，夹在 20s ~ 10min。 */
export function nextWake(registry) {
  const now = Date.now();
  let soon = Infinity;
  for (const s of registry.sources) {
    if (!s.runnable) continue;
    const h = store.health.get(s.id);
    const at = (h?.last_run || 0) + s.interval * 1000;
    if (at < soon) soon = at;
  }
  if (!Number.isFinite(soon)) return 60_000;
  return Math.max(20_000, Math.min(600_000, soon - now));
}

/** 常驻循环 */
export async function loop(registry, { log = console.log } = {}) {
  let cycles = 0;
  for (;;) {
    const r = await runCycle(registry, { log });
    if (r.ran) {
      cycles++;
      if (cycles % 24 === 0) { const n = store.prune(); if (n) log(`[store] 清理 ${n} 个过期分片`) }
      log(`[ingest] 本轮 +${r.added} 条，失败 ${r.failed}/${r.ran}；${(r.next / 1000).toFixed(0)}s 后再来`);
    }
    await sleep(r.next);
  }
}
