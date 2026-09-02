// 注册表：sources.json + adapters/*.mjs → 可执行源列表 + 前端能力清单。
// 加一个源 = 改 sources.json + 写一个导出函数。前端读 /api/sources 自适应，不用改 UI。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as adapters from './adapters/index.mjs';

export function loadRegistry({ dir = process.cwd(), log = console.log } = {}) {
  const conf = JSON.parse(readFileSync(join(dir, 'sources.json'), 'utf8'));
  const sources = [];
  const problems = [];

  for (const s of conf.sources) {
    const fn = adapters[s.adapter];
    if (typeof fn !== 'function') {
      problems.push(`${s.id}: 找不到适配器 "${s.adapter}"（适配器不存在，源已跳过）`);
      continue;
    }
    const missing = (s.needs_key || '').split(',').map(x => x.trim()).filter(Boolean)
      .filter(k => !process.env[k]);
    sources.push({
      ...s,
      fn,
      missing_keys: missing,
      // 缺密钥的源静默禁用（不报错刷屏）；interval=0 表示非轮询源（如 WebSocket）
      runnable: s.interval > 0 && missing.length === 0,
      disabled_reason: missing.length ? `缺少 ${missing.join(', ')}` : (s.interval === 0 ? '非轮询源' : null),
    });
  }
  for (const p of problems) log(`[registry] ! ${p}`);

  // 按源保留期：GDELT 一个源就是其它所有源的二十倍，一刀切的 KEEP_DAYS 一定会留错东西
  const retention = {};
  for (const s of sources) if (s.keep_days) retention[s.id] = s.keep_days;

  return {
    groups: conf.groups,
    sources,
    retention,
    byId: new Map(sources.map(s => [s.id, s])),
    /** 给前端的自描述清单：类型、周期、是否带坐标、是否可用 */
    capabilities() {
      return sources.map(s => ({
        id: s.id, label: s.label, group: s.group, kind: s.kind, points: !!s.points,
        series: !!s.series, interval: s.interval, license: s.license || null,
        note: s.note || null, runnable: s.runnable, disabled_reason: s.disabled_reason,
        regions: s.regions?.map(r => r.name) || null,
      }));
    },
  };
}
