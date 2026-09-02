#!/usr/bin/env node
// 端到端自检：拉起服务 → 打每个端点 → 断言形状 → 关服务。
// 用法： node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const PORT = Number(process.env.SMOKE_PORT || 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['--no-warnings', 'src/server.mjs'], {
  env: { ...process.env, PORT: String(PORT), MAX_PARALLEL: '4' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const log = [];
child.stdout.on('data', d => log.push(String(d)));
child.stderr.on('data', d => log.push('[err] ' + String(d)));

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

try {
  // 等端口起来
  let up = false;
  for (let i = 0; i < 60; i++) {
    await wait(1000);
    try { const r = await fetch(`${BASE}/api/stats`); if (r.ok) { up = true; break } } catch {}
  }
  ok('服务启动', up);
  if (!up) { console.log(log.join('')); process.exit(1) }

  // 首轮抓取要几十秒（GDELT 有 10 秒限速，光它一家就 ~100 秒）。
  // 等「多个源都落地」再断言，否则测的是竞态不是代码。
  let landed = 0, srcs = 0;
  for (let i = 0; i < 120; i++) {
    const st = await (await fetch(`${BASE}/api/stats`)).json();
    landed = st.total; srcs = Object.keys(st.sources).length;
    if (landed > 200 && srcs >= 6) break;
    await wait(2000);
  }
  ok('首轮抓取落地', landed > 200 && srcs >= 6, `${landed} 条事件 / ${srcs} 个源有数据`);

  const sources = await (await fetch(`${BASE}/api/sources`)).json();
  ok('/api/sources 有能力清单', Array.isArray(sources.sources) && sources.sources.length >= 15,
     `${sources.sources.length} 个源，${sources.sources.filter(s => s.runnable).length} 个已启用`);
  ok('每个源都自报 kind/interval', sources.sources.every(s => s.kind && s.interval !== undefined));
  ok('缺密钥的源被标记而不是崩掉',
     sources.sources.filter(s => !s.runnable).every(s => !!s.disabled_reason),
     sources.sources.filter(s => !s.runnable).map(s => `${s.id}(${s.disabled_reason})`).join(' '));
  ok('kind 色板存在', Object.keys(sources.kinds).length >= 8, Object.keys(sources.kinds).join(','));

  const ev = await (await fetch(`${BASE}/api/events?hours=168&limit=9000`)).json();
  ok('/api/events 返回信封字段', ev.events.length === 0 || ['id', 'source', 'kind', 'ts', 'ingest_ts', 'ttl']
     .every(k => k in ev.events[0]), `${ev.events.length} 条 / 全库 ${ev.total}`);
  ok('事件时间不倒挂', ev.events.every(e => e.ts <= e.ingest_ts + 900));
  ok('geo 字段要么都有要么都没有（不出现 NaN）',
     ev.events.every(e => (Number.isFinite(e.lat) === Number.isFinite(e.lon))));
  const withGeo = ev.events.filter(e => Number.isFinite(e.lat)).length;
  ok('有可上图的点', withGeo > 0, `${withGeo} 条带坐标`);

  const all168 = await (await fetch(`${BASE}/api/events?hours=168&limit=9000`)).json();
  const bbox = await (await fetch(`${BASE}/api/events?hours=168&bbox=-12,40,35,62&limit=9000`)).json();
  const inside = bbox.events.every(e => !Number.isFinite(e.lat) ? false : (e.lat >= 40 && e.lat <= 62 && e.lon >= -12 && e.lon <= 35));
  ok('bbox 过滤生效（要求：非空、且严格是全集子集）',
     inside && bbox.events.length > 0 && bbox.events.length <= all168.events.length,
     `欧洲 ${bbox.events.length} / 全集 ${all168.events.length}`);
  // bbox 带不带坐标的语义要一致：无坐标事件在 bbox 查询里必须被排除
  ok('bbox 查询排除无坐标事件', bbox.events.every(e => Number.isFinite(e.lat)));
  const noBboxHasNull = all168.events.some(e => !Number.isFinite(e.lat));
  console.log(`  ℹ️ 全集里 ${noBboxHasNull ? '有' : '没有'}无坐标事件（宏观/制裁类），bbox 查询会把它们排除`);
  const kindsQ = await (await fetch(`${BASE}/api/events?hours=168&kinds=disaster&limit=5000`)).json();
  ok('kinds 过滤生效', kindsQ.events.every(e => e.kind === 'disaster'), `${kindsQ.events.length} 条`);
  const qQ = await (await fetch(`${BASE}/api/events?hours=168&q=M&limit=20`)).json();
  ok('关键词过滤生效', Array.isArray(qQ.events), `${qQ.events.length} 条命中`);

  const ser = await (await fetch(`${BASE}/api/series?hours=24&buckets=60`)).json();
  ok('/api/series 分桶数正确', Object.values(ser.series).every(a => a.length === ser.buckets),
     `buckets=${ser.buckets}，${Object.keys(ser.series).length} 条序列`);

  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  ok('/api/stats 带健康信息', Array.isArray(stats.health) && stats.health.length > 0,
     `${stats.health.length} 个源有采集记录`);
  ok('失败被记录而不是静默', stats.health.every(([, h]) => h.last_run > 0));
  const zeroWithNote = stats.health.filter(([, h]) => h.last_count === 0);
  ok('取回 0 条的源都给了原因', zeroWithNote.every(([, h]) => !!h.note || !!h.last_err),
     zeroWithNote.length ? `0 条的源：${zeroWithNote.map(([id]) => id).join(', ')}` : '本轮没有 0 条的源');

  const csv = await (await fetch(`${BASE}/api/export.csv?hours=168`)).text();
  ok('/api/export.csv 可下载', csv.startsWith('id,source,kind,') && csv.split('\n').length > 5,
     `${csv.split('\n').length - 1} 行`);

  for (const f of ['/', '/app.js', '/style.css']) {
    const r = await fetch(BASE + f);
    const body = await r.text();
    ok(`静态资源 ${f}`, r.ok && body.length > 200, `${body.length}B`);
  }
  const nf = await fetch(`${BASE}/api/nope`);
  ok('未知端点返回 404 而不是 500', nf.status === 404);
  const wrongMethod = await fetch(`${BASE}/api/refresh`);           // GET 一个只接受 POST 的路径
  const wm = await wrongMethod.json();
  ok('方法用错时返回 405 并告知正确方法', wrongMethod.status === 405 && /POST/.test(wm.error), wm.error);
  const trav = await fetch(`${BASE}/../package.json`);
  ok('目录穿越被挡', [400, 404].includes(trav.status));

  // 手动抓取：默认后台触发（GDELT 一轮 ~100s，同步等待会卡界面），?sync=1 才是同步
  const ra = await (await fetch(`${BASE}/api/refresh?source=nosuch_source`, { method: 'POST' })).json();
  ok('不存在的源被点名且不跑其它源', ra.scheduled === true && ra.targets.length === 0 && ra.unknown?.[0] === 'nosuch_source',
     JSON.stringify({ targets: ra.targets, unknown: ra.unknown }));
  const rs = await (await fetch(`${BASE}/api/refresh?source=usgs_quakes&force=1&sync=1`, { method: 'POST' })).json();
  ok('POST /api/refresh?sync=1 能强制重抓单源', rs.ran === 1 && rs.results?.[0]?.ok,
     JSON.stringify(rs.results?.[0] || { ran: rs.ran }));
  const rbg = await (await fetch(`${BASE}/api/refresh`, { method: 'POST' })).json();
  ok('默认模式立即返回且报出目标源清单', rbg.scheduled === true && rbg.targets.length >= 10,
     `${rbg.targets.length} 个源已排入后台`);
} catch (e) {
  fail++;
  console.log('  FAIL 异常：', e.message, '\n', log.join('').slice(-3000));
} finally {
  child.kill('SIGTERM');
}
console.log(`\n${pass} 通过 / ${fail} 失败`);
if (fail) console.log('--- 服务日志尾部 ---\n' + log.join('').slice(-2500));
process.exit(fail ? 1 : 0);
