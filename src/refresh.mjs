#!/usr/bin/env node
// 一次性抓取，给 cron / systemd timer 用。
//   node src/refresh.js                     抓所有到期的源
//   node src/refresh.js --force             全部重抓
//   node src/refresh.js usgs_quakes gdelt   只抓指定的
import { loadRegistry } from './registry.mjs';
import { runCycle } from './ingest.mjs';
import { store } from './store.mjs';

const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter(a => !a.startsWith('--'));

const registry = loadRegistry();
store.setRetention(registry.retention);
store.warm();
const r = await runCycle(registry, { only: only.length ? only : null, force });
const c = store.counts();

console.log(`\n本轮：跑了 ${r.ran} 个源，新增 ${r.added} 条，失败 ${r.failed} 个`);
console.log(`库存：${c.total} 条 / ${Object.keys(c.sources).length} 个源`);
console.log('按类型：', Object.entries(c.kinds).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  '));
process.exit(r.failed && r.ran === r.failed ? 1 : 0);
