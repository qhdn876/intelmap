#!/usr/bin/env node
// 自检：每个源的适配器能否解析、实际能否取回数据、耗时多少、数据新不新、0 条时为什么。
// 用法： node scripts/verify-sources.mjs            全部
//       node scripts/verify-sources.mjs usgs eonet  只测 id 含这些词的
import { loadRegistry } from '../src/registry.mjs';
import { makeEvent } from '../src/envelope.mjs';

const filter = process.argv.slice(2);
const registry = loadRegistry();
let issues = 0;
console.log('id                       事件数  带坐标  最新事件       耗时     状态');
console.log('-'.repeat(84));

for (const s of registry.sources) {
  if (filter.length && !filter.some(f => s.id.includes(f))) continue;
  if (!s.runnable) {
    console.log(`${s.id.padEnd(24)}    --     --       --         --     ⏸ ${s.disabled_reason}`);
    continue;
  }
  const t0 = Date.now();
  try {
    const r = await s.fn({ source: s, registry, log: () => {}, bboxIndex: 0 });
    const raw = Array.isArray(r) ? r : (r?.events || []);
    const note = Array.isArray(r) ? null : (r?.note || null);
    const ev = raw.map(p => makeEvent(s, p));
    const geo = ev.filter(e => Number.isFinite(e.lat)).length;
    const age = ev.length ? Math.round((Date.now() / 1000 - Math.max(...ev.map(e => e.ts))) / 60) : null;
    const ageS = age == null ? '--' : age <= 0 ? '刚刚' : age < 60 ? `${age}m前` : `${(age / 60).toFixed(1)}h前`;
    const ok = ev.length > 0;
    console.log(`${s.id.padEnd(24)} ${String(ev.length).padStart(6)} ${String(geo).padStart(6)}  ${ageS.padStart(9)}  ${String(Date.now() - t0).padStart(7)}ms  ${ok ? '✓' : '·'}${note ? '  ' + note : ''}`);
    if (!ok && !note) { issues++; console.log(' ' .repeat(24) + '   ⚠ 0 条且适配器没给原因 —— 无法区分「没数据」和「抓坏了」') }
    if (!ok && /返回空数组/.test(note || '')) issues++;
  } catch (e) {
    issues++;
    console.log(`${s.id.padEnd(24)}    --     --       --     ${String(Date.now() - t0).padStart(6)}ms  ✗ ${e.message}`);
  }
}
console.log(`\n${issues} 个源需要人工确认。`);
process.exit(issues ? 3 : 0);
