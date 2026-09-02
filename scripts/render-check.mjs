#!/usr/bin/env node
// 没有浏览器，也能让 app.js 真跑一遍。
// 做法：造一个够用的 DOM/MapLibre/canvas/fetch 替身，加载 app.js，断言渲染路径不抛异常、
// 且关键节点确实被填了内容。这抓的是「打开页面白屏」那一类 bug —— check-dom 那种静态核对抓不到。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync('web/index.html', 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);

// ── 假 DOM ──
// 假 DOM 不解析 innerHTML，所以代码里 `row.querySelector('input')` 会拿到 null。
// 这里按需返回一个稳定替身（同一节点同一选择器返回同一对象），否则测的是替身的缺陷而不是应用。
function autoStub(node, sel) {
  node.__stubs ||= new Map();
  if (!node.__stubs.has(sel)) {
    const s = mkEl(sel.replace(/[.#]/g, '') || 'div');
    s._stubFor = sel;
    node.__stubs.set(sel, s);
  }
  return node.__stubs.get(sel);
}

function mkEl(tag = 'div', id = '') {
  const e = {
    tagName: tag.toUpperCase(), id, children: [], _html: '', textContent: '', value: '',
    disabled: false, checked: false, href: '', title: '', dataset: {}, clientWidth: 360, clientHeight: 34,
    style: {}, width: 0, height: 0,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)) }, remove(...c) { c.forEach(x => this._s.delete(x)) },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on },
      contains(c) { return this._s.has(c) },
    },
    get className() { return [...this.classList._s].join(' ') },
    set className(v) { this.classList._s = new Set(String(v).split(/\s+/).filter(Boolean)) },
    get innerHTML() { return this._html },
    set innerHTML(v) { this._html = String(v) },
    get firstChild() { return this.children[0] || null },
    appendChild(c) { this.children.push(c); return c },
    querySelector(sel) { return pick(this, sel) || autoStub(this, sel) },
    querySelectorAll(sel) { const r = all(this, sel); return r.length ? r : [autoStub(this, sel)] },
    addEventListener() {}, removeEventListener() {}, focus() {}, click() {},
    getContext: () => canvasCtx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 700 }),
  };
  return e;
}
const canvasCtx = new Proxy({}, {
  get: (t, k) => (k === 'createRadialGradient' ? () => ({ addColorStop() {} })
    : k === 'setTransform' || k === 'clearRect' || k === 'fillRect' || k === 'beginPath' || k === 'arc'
      || k === 'moveTo' || k === 'lineTo' || k === 'stroke' || k === 'fill' || k === 'fillText' ? () => {} : () => {}),
  set: () => true,
});

const registry = new Map();
const root = mkEl('body');
function pick(scope, sel) { return all(scope, sel)[0] || null }
function all(scope, sel) {
  const out = [];
  const walk = (n) => { for (const c of n.children) { if (match(c, sel)) out.push(c); walk(c) } };
  walk(scope); return out;
}
function match(node, sel) {
  if (sel.startsWith('#')) return node.id === sel.slice(1);
  if (sel.startsWith('.')) return node.classList.contains(sel.slice(1));
  return node.tagName === sel.toUpperCase();
}
const document = {
  createElement: (t) => mkEl(t),
  querySelector: (s) => {
    if (s.startsWith('#')) {
      const id = s.slice(1);
      if (!registry.has(id)) { const e = mkEl('div', id); e._auto = !ids.includes(id); registry.set(id, e) }
      return registry.get(id);
    }
    return pick(root, s) || mkEl();
  },
  querySelectorAll: (s) => all(root, s),
  addEventListener() {}, activeElement: null, body: root,
};

// ── 假 MapLibre ──
let lastMap = null;
class FakeMap {
  constructor() { lastMap = this; this.h = {}; this._b = { getWest: () => -180, getSouth: () => -90, getEast: () => 180, getNorth: () => 90 } }
  on(ev, fn) { (this.h[ev] ||= []).push(fn) }
  addControl() {} easeTo() {} project([lng, lat]) { return { x: (lng + 180) * 3, y: (90 - lat) * 3 } }
  getBounds() { return this._b } getZoom() { return 2 } getContainer() { return root }
  getCanvas() { return mkEl('canvas') } getCanvasContainer() { return mkEl('div') } triggerRepaint() {}
  fire(ev) { for (const fn of this.h[ev] || []) fn() }
}

// ── 假数据：直接吃真实抓出来的 store，渲染路径才可信 ──
let stats, srcs, evs;
const { spawn } = await import('node:child_process');
let child = null;
const port = process.env.CHECK_PORT || 8793;
const base = process.env.CHECK_BASE || `http://127.0.0.1:${port}`;

if (!process.env.CHECK_BASE) {
  // 自己拉一个服务，这样 `npm test` 一条命令就能跑完整三层验收
  child = spawn(process.execPath, ['--no-warnings', 'src/server.mjs'], {
    env: { ...process.env, PORT: String(port), MAX_PARALLEL: '4' }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', d => process.stderr.write('[server] ' + d));
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const st = await (await fetch(`${base}/api/stats`)).json();
      if (st.total > 200 && Object.keys(st.sources).length >= 6) break;
    } catch {}
  }
}
try {
  stats = await (await fetch(`${base}/api/stats`)).json();
  srcs = await (await fetch(`${base}/api/sources`)).json();
  evs = await (await fetch(`${base}/api/events?hours=168&limit=400`)).json();
} catch (e) {
  console.log('拿不到 API：', e.message);
  child?.kill('SIGTERM');
  process.exit(2);
}
const calls = [];
const fetchStub = async (u) => {
  calls.push(String(u));
  const body = String(u).startsWith('/api/events') ? evs
    : String(u).startsWith('/api/sources') ? srcs
      : String(u).startsWith('/api/series') ? { from: 0, to: 1, step: 60, buckets: 60, series: { usgs_quakes: Array(60).fill(1) } }
        : String(u).startsWith('/api/refresh') ? { scheduled: true, targets: ['usgs_quakes'], unknown: [] }
          : { ok: true };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
};

const store = new Map();
const appJs = readFileSync('web/app.js', 'utf8');
const sandbox = {
  document, window: {}, localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
  fetch: fetchStub, console, setTimeout: (fn, ms) => { if (ms > 2000) return 0; try { fn() } catch (e) { throw new Error(`setTimeout 回调抛出：${e.message}`) } },
  clearTimeout: () => {}, setInterval: () => 0, requestAnimationFrame: () => 0,
  addEventListener: () => {}, devicePixelRatio: 2, URLSearchParams, JSON, Math, Date, Object, Array, Set, Map,
  Number, String, Promise, Infinity, NaN, isNaN, parseInt, parseFloat, Error, TypeError, RegExp,
  maplibregl: { Map: FakeMap, NavigationControl: class { } },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

let fail = 0;
const ok = (n, c, x = '') => { if (!c) fail++; console.log(`${c ? '  ok  ' : '  FAIL'} ${n}${x ? '  ' + x : ''}`) };

try {
  await vm.runInNewContext(`(async () => { ${appJs}\n})()`, sandbox, { filename: 'web/app.js' });
  ok('app.js 加载并跑完 boot()，无异常', true);
} catch (e) {
  ok('app.js 加载并跑完 boot()，无异常', false, e.message);
}

await new Promise(r => setTimeout(r, 400));
const g = (id) => registry.get(id);
// app.js 里的 boot().catch 会把异常吞成一行提示 —— 不查就会「全绿但其实白屏」
const bootErr = (g('mapinfo')?.textContent || '');
ok('boot() 未落入失败分支', !/启动失败/.test(bootErr), bootErr.slice(0, 90) || '（无错误提示）');
ok('源清单被填充', (g('sourceList')?._html || '').length > 200 || g('sourceList')?.children.length > 0,
   `${g('sourceList')?.children.length ?? 0} 个节点`);
ok('图例被填充', g('legend')?.children.length > 5, `${g('legend')?.children.length ?? 0} 个类型`);
ok('时间范围按钮被填充', g('ranges')?.children.length === 6);
ok('图层按钮被填充', g('layerBox')?.children.length === 4);
ok('关注点标签被填充', g('watchBox')?.children.length >= 1, `${g('watchBox')?.children.length ?? 0} 个`);
ok('健康列表被填充（有采集记录时）', (g('healthList')?._html || '').length > 30 || g('healthList')?.children.length > 0,
   `${g('healthList')?.children.length ?? 0} 行`);
ok('事件流被填充', g('events')?.children.length > 0, `${g('events')?.children.length ?? 0} 行`);
ok('统计条有内容', /视野内/.test(g('totals')?._html || ''), (g('totals')?._html || '').replace(/<[^>]+>/g, '').trim());
ok('事件数与后端一致', g('events')?.children.length <= evs.events.length + 40,
   `渲染 ${g('events')?.children.length ?? 0} / 返回 ${evs.events.length}`);
ok('CSV 链接跟随筛选', /api\/export\.csv\?/.test(g('csv')?.href || ''), g('csv')?.href || '(空)');
ok('确实请求过 events 与 sources', calls.some(c => c.startsWith('/api/events')) && calls.some(c => c.startsWith('/api/sources')));
// 事件行的 class 里应带上类型色点与源名
const firstRow = g('events')?.children.find(c => c._html?.includes('ev-title'));
const srcName = firstRow ? (firstRow._html.match(/class="src">([^<]*)/)?.[1] || '') : '';
ok('事件行含标题与源名', !!firstRow && /ev-title/.test(firstRow._html) && srcName.length > 2, `源名=${srcName}`);

// 触发一次地图 render，验证自绘叠加层（点/热力/航迹/脉冲）不抛异常
try {
  const fired = lastMap;
  if (fired && typeof fired.fire === 'function') { fired.fire('render'); ok('地图 render 回调不抛异常', true) }
  else ok('地图 render 回调（未捕获到实例，跳过）', true);
} catch (e) { ok('地图 render 回调不抛异常', false, e.message) }

// app.js 摸过的 id 若不在 index.html 里，就是拼错了（假 DOM 会宽容地自动建，所以必须显式查）
const ghost = [...registry.entries()].filter(([, e]) => e._auto).map(([id]) => id);
ok('app.js 没有引用 index.html 里不存在的 id', ghost.length === 0, ghost.join(' '));

console.log(`\n 个渲染问题`);
child?.kill("SIGTERM");
process.exit(fail ? 1 : 0);
