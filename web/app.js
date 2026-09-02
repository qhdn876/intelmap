// intelmap 前端。没有框架：一个状态对象 + 若干渲染函数 + MapLibre 底图 + 一个自绘 canvas 叠加层。
//
// 为什么自绘而不全用 MapLibre layer：热力/航迹/新事件脉冲这三种东西用原生 layer 各自都要
// 维护独立 source + 表达式，且互相叠加顺序难调。一个 canvas 一次遍历画完，代码更少也更好读。
// 代价是点击命中要自己做（见 pickAt），也就 15 行。
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ago = (ts) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 10) return '刚刚';
  if (s < 90) return `${s}秒前`;
  if (s < 5400) return `${Math.round(s / 60)}分钟前`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}小时前`;
  if (s < 604800) return `${(s / 86400).toFixed(1)}天前`;
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};
const hhmm = (ts) => new Date(ts * 1000).toLocaleTimeString('zh-CN', { hour12: false });

/* ── 状态：只有「你的偏好」进 localStorage，数据永远从服务端拿 ── */
const S = {
  hours: 24,
  kinds: new Set(),          // 空 = 不过滤
  off: new Set(),            // 取消勾选的源（黑名单比白名单省心：新出现的源默认是开的）
  q: '',
  watch: ['霍尔木兹', '红海', '海底电缆', '空域关闭', '半导体管制'],
  onlyMatch: false,
  layers: { points: true, heat: false, trails: true, pulse: true },
  auto: true, next: 0,
  seen: new Set(), news: new Set(),
  events: [], sources: [], kinds_meta: {}, groups: {},
  selected: null, hover: null,
  loading: false, err: null,
};
try {
  const p = JSON.parse(localStorage.getItem('intelmap.prefs') || '{}');
  Object.assign(S, { hours: p.hours ?? S.hours, watch: p.watch ?? S.watch, layers: { ...S.layers, ...(p.layers || {}) } });
} catch {}
const savePrefs = () => { try { localStorage.setItem('intelmap.prefs', JSON.stringify({ hours: S.hours, watch: S.watch, layers: S.layers })) } catch {} };
const matched = (e) => S.watch.some(w => `${e.title} ${(e.tags || []).join(' ')} ${e.url || ''}`.toLowerCase().includes(w.toLowerCase()));
const geoPts = () => S.events.filter(e => Number.isFinite(e.lat) && Number.isFinite(e.lon));

/* ── 地图 ── */
const map = new maplibregl.Map({
  container: 'map', center: [22, 27], zoom: 1.5, minZoom: 0.5, maxZoom: 12,
  worldCopyJump: true, attributionControl: { compact: true },
  style: {
    version: 8,
    sources: { base: { type: 'raster', tileSize: 256, maxzoom: 8, attribution: '© OpenStreetMap · CARTO',
      tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
              'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'] } },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');

/* ── 叠加层 ── */
const cv = document.createElement('canvas');
cv.id = 'overlay';
$('#mapwrap').appendChild(cv);
const g = cv.getContext('2d');
let phase = 0;

// 只在尺寸变化时重设 canvas：每帧赋 width 会强制清空并触发布局，白白掉一半帧率
let sized = { w: 0, h: 0 };
function fitCanvas() {
  const r = map.getContainer().getBoundingClientRect();
  if (r.width === sized.w && r.height === sized.h) return;
  sized = { w: r.width, h: r.height };
  const dpr = devicePixelRatio || 1;
  cv.width = Math.max(1, r.width * dpr); cv.height = Math.max(1, r.height * dpr);
  cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function radiusFor(e) {
  return Math.min(16, 2.4 + Math.log(1 + (e.weight || 1)) * 4.2);
}

function drawPoints() {
  for (const e of geoPts()) {
    const q = map.project([e.lon, e.lat]);
    const r = radiusFor(e);
    const col = S.kinds_meta[e.kind]?.color || '#8d99ae';
    const dim = S.selected && S.selected.id !== e.id;
    g.globalAlpha = dim ? 0.55 : 0.95;
    g.beginPath(); g.arc(q.x, q.y, r, 0, 7);
    g.fillStyle = col; g.fill();
    g.lineWidth = 0.8; g.strokeStyle = 'rgba(8,11,16,.85)'; g.stroke();
    if (matched(e)) {                       // 命中关注点 → 描一圈金边
      g.globalAlpha = 1; g.lineWidth = 1.6; g.strokeStyle = '#ffd166';
      g.beginPath(); g.arc(q.x, q.y, r + 2.4, 0, 7); g.stroke();
    }
  }
  g.globalAlpha = 1;
  if (S.selected && Number.isFinite(S.selected.lat)) {
    const q = map.project([S.selected.lon, S.selected.lat]);
    const r = radiusFor(S.selected) + 5;
    g.strokeStyle = '#fff'; g.lineWidth = 1.8;
    g.beginPath(); g.arc(q.x, q.y, r, 0, 7); g.stroke();
    g.beginPath(); g.moveTo(q.x - r - 7, q.y); g.lineTo(q.x - r - 1, q.y);
    g.moveTo(q.x + r + 1, q.y); g.lineTo(q.x + r + 7, q.y);
    g.moveTo(q.x, q.y - r - 7); g.lineTo(q.x, q.y - r - 1);
    g.moveTo(q.x, q.y + r + 1); g.lineTo(q.x, q.y + r + 7); g.stroke();
  }
}

// 热力：按权重撒径向光斑，'lighter' 叠加。不追求 GIS 精度，追求「哪里在冒烟」一眼看见。
function drawHeat() {
  g.globalCompositeOperation = 'lighter';
  const w = cv.clientWidth, h = cv.clientHeight;
  for (const e of geoPts()) {
    const q = map.project([e.lon, e.lat]);
    if (q.x < -90 || q.y < -90 || q.x > w + 90 || q.y > h + 90) continue;
    const rad = 30 + Math.min(70, (e.weight || 1) * 11);
    const col = S.kinds_meta[e.kind]?.color || '#8d99ae';
    const grd = g.createRadialGradient(q.x, q.y, 0, q.x, q.y, rad);
    grd.addColorStop(0, col + '90'); grd.addColorStop(.55, col + '30'); grd.addColorStop(1, col + '00');
    g.fillStyle = grd; g.beginPath(); g.arc(q.x, q.y, rad, 0, 7); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
}

// 航迹：同一目标（icao24 / mmsi / 网格）按时间串成折线 —— 这是「趋势」最便宜的画法
function drawTrails() {
  const groups = new Map();
  for (const e of geoPts()) {
    const who = e.meta?.icao24 || e.meta?.mmsi || e.meta?.cell || e.meta?.query;
    if (!who) continue;
    if (!groups.has(who)) groups.set(who, []);
    groups.get(who).push(e);
  }
  g.lineWidth = 1.15;
  for (const arr of groups.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.ts - b.ts);
    g.strokeStyle = (S.kinds_meta[arr[0].kind]?.color || '#8d99ae') + '66';
    g.beginPath();
    arr.forEach((e, i) => { const q = map.project([e.lon, e.lat]); i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y) });
    g.stroke();
  }
}

function drawPulse() {
  const now = Math.floor(Date.now() / 1000);
  const fresh = geoPts().filter(e => now - e.ingest_ts < 120);
  if (!fresh.length) return;
  phase = (phase + 0.015) % 1;
  for (const e of fresh) {
    const q = map.project([e.lon, e.lat]);
    const r = radiusFor(e) + phase * 20;
    g.strokeStyle = `rgba(255,255,255,${(0.5 * (1 - phase)).toFixed(3)})`;
    g.lineWidth = 1.5; g.beginPath(); g.arc(q.x, q.y, r, 0, 7); g.stroke();
  }
  requestAnimationFrame(() => map.triggerRepaint());   // 让脉冲自己转起来
}

function paint() {
  fitCanvas();
  g.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
  if (S.layers.heat) drawHeat();
  if (S.layers.trails) drawTrails();
  if (S.layers.points) drawPoints();
  if (S.layers.pulse) drawPulse();
}
map.on('render', paint);
map.on('load', fitCanvas);
map.on('resize', fitCanvas);
addEventListener('resize', fitCanvas);

/* ── 命中检测 ── */
function pickAt(px, py) {
  let best = null, bestD = Infinity;
  for (const e of geoPts()) {
    const q = map.project([e.lon, e.lat]);
    const d = Math.hypot(q.x - px, q.y - py);
    const hitR = Math.max(9, radiusFor(e) + 4);       // 小点也给 9px 容差，否则根本点不中
    if (d <= hitR && d < bestD) { best = e; bestD = d }
  }
  return best;
}
map.getCanvasContainer().addEventListener('click', (ev) => {
  const r = map.getContainer().getBoundingClientRect();
  const e = pickAt(ev.clientX - r.left, ev.clientY - r.top);
  if (e) select(e); else $('#detail').classList.add('hidden'), (S.selected = null);
});
map.getCanvasContainer().addEventListener('mousemove', (ev) => {
  const r = map.getContainer().getBoundingClientRect();
  S.hover = pickAt(ev.clientX - r.left, ev.clientY - r.top);
  map.getCanvas().style.cursor = S.hover ? 'pointer' : '';
});

/* ── 数据 ── */
async function j(u, o) {
  const r = await fetch(u, o);
  if (!r.ok) throw new Error(`HTTP ${r.status} · ${u}`);
  return r.json();
}

async function boot() {
  const s = await j('/api/sources');
  S.sources = s.sources; S.kinds_meta = s.kinds; S.groups = s.groups;
  renderRanges(); renderLayers(); renderRail(s); renderLegend(); renderWatch(); renderHealth(s);
  await reload();
  setInterval(() => { if (S.auto && Date.now() > S.next) reload(true) }, 5000);
  setInterval(tick, 1000);
}

async function reload(quiet) {
  if (S.loading) return;
  S.loading = true; S.next = Date.now() + 60_000;
  const b = map.getBounds();
  const p = new URLSearchParams({
    hours: S.hours, limit: 6000,
    bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(','),
  });
  if (S.kinds.size) p.set('kinds', [...S.kinds].join(','));
  if (S.off.size) p.set('sources', S.sources.filter(x => x.runnable && !S.off.has(x.id)).map(x => x.id).join(','));
  if (S.q) p.set('q', S.q);
  $('#mapinfo').textContent = '取数中…';
  try {
    const [ev, ser, src] = await Promise.all([
      j(`/api/events?${p}`), j(`/api/series?hours=${S.hours}&buckets=60`), j('/api/sources'),
    ]);
    S.news = new Set(ev.events.filter(e => !S.seen.has(e.id) && Date.now() / 1000 - e.ingest_ts < 900).map(e => e.id));
    ev.events.forEach(e => S.seen.add(e.id));
    S.events = ev.events;
    S.sources = src.sources; S.err = null;
    renderHealth(src);
    updateSrcCounts(ev.events);
    drawStream(); drawSpark(ser); paint();
    $('#totals').innerHTML = `视野内 <b>${ev.events.length}</b> 条${ev.total > ev.events.length ? ` / 命中 ${ev.total.toLocaleString()} 条（已截断）` : ''}`;
    $('#mapinfo').textContent = '地图 = 当前视野内带坐标的点；拖动或缩放会重新取数。无坐标事件只在右侧出现。';
    $('#csv').href = `/api/export.csv?${p}`;      // 导出跟随当前筛选，不然导出的和看到的不是一回事
    if (!quiet && S.news.size) toast(`载入 ${ev.events.length} 条，其中 ${S.news.size} 条是首次看到`);
  } catch (e) {
    S.err = e.message;
    $('#mapinfo').textContent = `取数失败：${e.message}`;
  } finally { S.loading = false }
}

/* ── 渲染：右侧事件流 ── */
function drawStream() {
  const box = $('#events'); box.textContent = '';
  const shown = S.events.filter(e => !S.onlyMatch || matched(e));
  $('#streamCount').textContent = `${shown.length} 条${S.onlyMatch ? '（仅命中）' : ''}`;
  $('#newCount').textContent = S.news.size ? `本轮新增 ${S.news.size}` : '';
  let lastDay = '';
  for (const e of shown.slice(0, 600)) {
    const day = new Date(e.ts * 1000).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
    if (day !== lastDay) { lastDay = day; box.appendChild(el('div', 'daysep', day)) }
    const k = S.kinds_meta[e.kind] || { label: e.kind, color: '#8d99ae' };
    const row = el('div', 'ev'
      + (matched(e) ? ' match' : '')
      + (S.news.has(e.id) ? ' fresh' : '')
      + (S.selected?.id === e.id ? ' sel' : ''));
    row.innerHTML = `
      <div class="ev-top">
        <span class="dot" style="background:${k.color}"></span>
        <span class="kind">${esc(k.label)}</span>
        <span class="src">${esc(e.source)}</span>
        <span class="t" title="事件 ${hhmm(e.ts)} ／ 我们知道于 ${hhmm(e.ingest_ts)}">${ago(e.ts)}</span>
      </div>
      <div class="ev-title">${esc(e.title)}</div>
      ${e.tags?.length ? `<div class="tags">${e.tags.slice(0, 5).map(t => `<i>${esc(t)}</i>`).join('')}</div>` : ''}`;
    row.onclick = () => select(e);
    box.appendChild(row);
  }
  if (!shown.length) box.appendChild(el('div', 'empty',
    S.events.length ? '没有命中关注点的事件。' : '这个窗口内没有事件。把时间范围放大，或点右上「抓取」。'));
}

function select(e) {
  S.selected = e;
  if (Number.isFinite(e.lat)) map.easeTo({ center: [e.lon, e.lat], zoom: Math.max(map.getZoom(), 4.2), duration: 700 });
  const k = S.kinds_meta[e.kind] || { label: e.kind, color: '#888' };
  const lag = e.ingest_ts - e.ts;
  const d = $('#detail');
  d.classList.remove('hidden');
  d.innerHTML = `
    <button class="close" id="dClose">✕</button>
    <div class="d-kind" style="color:${k.color}">${esc(k.label)} · ${esc(e.source)}</div>
    <h3>${esc(e.title)}</h3>
    <div class="d-meta">
      <span>事件 ${hhmm(e.ts)}</span>
      <span title="从事件发生到我们知道，隔了多久">滞后 ${lag < 120 ? '<1 分钟' : lag < 7200 ? Math.round(lag / 60) + ' 分钟' : (lag / 3600).toFixed(1) + ' 小时'}</span>
      ${Number.isFinite(e.lat) ? `<span>${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}</span>` : '<span>无坐标</span>'}
      <span>TTL ${e.ttl >= 86400 ? e.ttl / 86400 + ' 天' : Math.round(e.ttl / 3600) + ' 小时'}</span>
    </div>
    ${e.tags?.length ? `<div class="tags">${e.tags.map(t => `<i>${esc(t)}</i>`).join('')}</div>` : ''}
    ${e.url ? `<a class="d-link" href="${esc(e.url)}" target="_blank" rel="noopener">看原始来源 ↗</a>` : ''}
    <details open><summary>原始字段（不加工，直接来自上游）</summary><pre>${esc(JSON.stringify(e.meta, null, 1))}</pre></details>`;
  $('#dClose').onclick = () => { S.selected = null; d.classList.add('hidden') };
  drawStream();
}

function drawSpark(ser) {
  const c = $('#spark'), x = c.getContext('2d');
  const dpr = devicePixelRatio || 1, W = c.clientWidth || 350, H = 34, n = 60;
  c.width = W * dpr; c.height = H * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, W, H);
  const tot = Array(n).fill(0);
  for (const arr of Object.values(ser.series || {})) {
    for (let i = 0; i < n; i++) tot[i] += arr[Math.min(arr.length - 1, Math.floor(i * arr.length / n))] || 0;
  }
  const max = Math.max(1, ...tot), bw = W / n;
  x.fillStyle = '#15202b'; x.fillRect(0, H - 1, W, 1);
  tot.forEach((v, i) => {
    if (!v) return;
    const h = Math.max(2, (v / max) * (H - 5));
    x.fillStyle = v >= max * .75 ? '#ff6b6b' : v >= max * .45 ? '#ffd166' : '#2f6f8f';
    x.fillRect(i * bw + .5, H - h, Math.max(1, bw - 1), h);
  });
  x.fillStyle = '#6f8095'; x.font = '9px ui-monospace,monospace';
  x.fillText(`${S.hours}h 窗口 · 峰值 ${max} 条/桶`, 2, 9);
}

/* ── 渲染：左侧 ── */
function renderRail(s) {
  const box = $('#sourceList'); box.textContent = '';
  const byGroup = {};
  for (const src of s.sources) (byGroup[src.group] ||= []).push(src);
  for (const [g, list] of Object.entries(byGroup)) {
    box.appendChild(el('div', 'grp', esc(s.groups?.[g] || g)));
    for (const src of list) {
      const row = el('div', 'src' + (src.runnable ? '' : ' off'));
      row.dataset.id = src.id;
      const per = src.interval >= 3600 ? `${(src.interval / 3600).toFixed(src.interval % 3600 ? 1 : 0)}h` : `${Math.round(src.interval / 60)}min`;
      row.innerHTML = `
        <label title="${esc(src.note || '')}&#10;周期 ${per} · 许可 ${esc(src.license || '—')}">
          <input type="checkbox" ${src.runnable && !S.off.has(src.id) ? 'checked' : ''} ${src.runnable ? '' : 'disabled'}>
          <span class="dot" style="background:${S.kinds_meta[src.kind]?.color || '#888'}"></span>
          <span class="lbl">${esc(src.label)}</span><span class="n">0</span>
        </label>
        ${src.runnable ? '' : `<div class="why">${esc(src.disabled_reason)}</div>`}`;
      row.querySelector('input').onchange = (e) => {
        e.target.checked ? S.off.delete(src.id) : S.off.add(src.id);
        reload(true);
      };
      box.appendChild(row);
    }
  }
  $('#srcCount').textContent = `${s.sources.filter(x => x.runnable).length}/${s.sources.length} 可用`;
}

function updateSrcCounts(events) {
  const c = {};
  for (const e of events) c[e.source] = (c[e.source] || 0) + 1;
  for (const row of $$('#sourceList .src')) row.querySelector('.n').textContent = c[row.dataset.id] || 0;
}

function renderLegend() {
  const box = $('#legend'); box.textContent = '';
  for (const [k, v] of Object.entries(S.kinds_meta)) {
    const on = S.kinds.has(k);
    const c = el('button', 'chip' + (on ? ' on' : ''), `<span class="dot" style="background:${v.color}"></span>${v.label}`);
    c.onclick = () => {
      S.kinds.has(k) ? S.kinds.delete(k) : S.kinds.add(k);
      c.classList.toggle('on', S.kinds.has(k));
      reload(true);
    };
    box.appendChild(c);
  }
}

function renderLayers() {
  const box = $('#layerBox'); box.textContent = '';
  for (const [k, label] of Object.entries({ points: '点', heat: '热力', trails: '航迹/聚类连线', pulse: '新事件脉冲' })) {
    const c = el('button', 'chip' + (S.layers[k] ? ' on' : ''), label);
    c.onclick = () => { S.layers[k] = !S.layers[k]; c.classList.toggle('on', S.layers[k]); savePrefs(); paint() };
    box.appendChild(c);
  }
}

function renderRanges() {
  const box = $('#ranges'); box.textContent = '';
  for (const [h, label] of [[1, '1h'], [6, '6h'], [24, '24h'], [72, '3d'], [168, '7d'], [720, '30d']]) {
    const b = el('button', 'chip' + (h === S.hours ? ' on' : ''), label);
    b.onclick = () => {
      S.hours = h; savePrefs();
      $$('#ranges .chip').forEach(x => x.classList.remove('on')); b.classList.add('on');
      reload();
    };
    box.appendChild(b);
  }
}

function renderHealth(s) {
  const box = $('#healthList'); box.textContent = '';
  const rows = s.sources.filter(x => x.health?.last_run).sort((a, b) => b.health.last_run - a.health.last_run);
  if (!rows.length) { box.innerHTML = '<div class="mut small">还没采集过。点右上「抓取」。</div>'; return }
  for (const x of rows) {
    const h = x.health;
    const staleMin = (Date.now() - h.last_run) / 60000;
    const stale = staleMin > (x.interval / 60) * 2.5;
    const d = el('div', 'hrow');
    d.innerHTML = `<span class="hdot ${h.last_err ? 'err' : stale ? 'warn' : 'ok'}"></span>
      <span class="hname">${esc(x.id)}</span>
      <span class="hts">${h.last_count ?? 0}条 · ${ago(Math.floor(h.last_run / 1000))}</span>`;
    d.title = [h.last_err && `错误：${h.last_err}`, h.note && `说明：${h.note}`,
      `上次运行 ${new Date(h.last_run).toLocaleString('zh-CN')}`, `许可：${x.license || '—'}`].filter(Boolean).join('\n');
    box.appendChild(d);
  }
}

/* ── 关注点 ── */
function renderWatch() {
  const box = $('#watchBox'); box.textContent = '';
  for (const w of S.watch) {
    const c = el('button', 'chip on', `${esc(w)} <b class="x">✕</b>`);
    c.onclick = () => { S.watch = S.watch.filter(x => x !== w); savePrefs(); renderWatch(); drawStream(); paint() };
    box.appendChild(c);
  }
  $('#watchCount').textContent = S.watch.length ? `${S.watch.length} 个词` : '（空）';
}
function addWatch() {
  const v = $('#watchInput').value.trim();
  if (!v || S.watch.includes(v)) return;
  S.watch.push(v); $('#watchInput').value = ''; savePrefs(); renderWatch(); drawStream(); paint();
}

/* ── 控件 ── */
$('#watchAdd').onclick = addWatch;
$('#watchInput').onkeydown = (e) => { if (e.key === 'Enter') addWatch() };
$('#onlyMatch').onchange = (e) => { S.onlyMatch = e.target.checked; drawStream() };
$('#refreshBtn').onclick = async () => {
  const b = $('#refreshBtn'); b.disabled = true; b.textContent = '已触发…';
  try {
    const r = await j('/api/refresh', { method: 'POST' });
    if (r.scheduled) {
      toast(`已触发 ${r.targets.length} 个源（GDELT 有 10 秒限速，约需 1–2 分钟）`);
      S.next = Date.now() + 8000;          // 短暂加快轮询，好早点看到新事件
    } else if (r.already_running) {
      toast(`上一次抓取还在跑（已进行 ${Math.round(r.since_ms / 1000)}s）`);
    } else {
      toast(`跑了 ${r.ran} 个源，新增 ${r.added} 条${r.failed ? `，失败 ${r.failed}` : ''}`);
      await reload(true);
    }
    if (r.unknown?.length) toast(`不存在的源：${r.unknown.join(', ')}`);
  } catch (e) { toast(`抓取失败：${e.message}`) }
  b.disabled = false; b.textContent = '抓取';
};
$('#autoBtn').onclick = (e) => { S.auto = !S.auto; e.target.classList.toggle('on', S.auto) };
let sTimer;
$('#search').oninput = (e) => { clearTimeout(sTimer); sTimer = setTimeout(() => { S.q = e.target.value.trim(); reload(true) }, 350) };
map.on('moveend', () => reload(true));
addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== $('#search')) { e.preventDefault(); $('#search').focus() }
  if (e.key === 'Escape') { $('#detail').classList.add('hidden'); S.selected = null; drawStream() }
  if (e.key === 'r' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#refreshBtn').click() }
});

function tick() { $('#tick').textContent = S.auto ? `${Math.max(0, Math.round((S.next - Date.now()) / 1000))}s 后刷新` : '自动已关' }
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2600);
}

boot().catch(e => { $('#mapinfo').textContent = `启动失败：${e.message}（后端起来了吗？）` });
