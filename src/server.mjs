#!/usr/bin/env node
// 一个进程干两件事：跑采集循环 + 提供 API 和静态前端。
// 想拆开：NO_INGEST=1 起服务，另用 cron 跑 node src/refresh.mjs。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRegistry } from './registry.mjs';
import { store } from './store.mjs';
import { runCycle, loop, nextWake } from './ingest.mjs';
import { KINDS } from './envelope.mjs';
import { stats as httpStats } from './http.mjs';
import { createMcpHandler } from './mcp.mjs';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const WEB = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'web');
const STARTED = Date.now();

// Basic Auth：设了 INTELMAP_AUTH 就启用，不设就开放（本地用）
const AUTH = process.env.INTELMAP_AUTH;  // 格式 "user:password"
const AUTH_HEADER = AUTH ? 'Basic ' + Buffer.from(AUTH).toString('base64') : null;

const registry = loadRegistry();
store.setRetention(registry.retention);
store.warm();

const handleMcp = createMcpHandler({ store, registry, KINDS });

const list = (v) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : null);
const box = (v) => { const a = list(v)?.map(Number); return a?.length === 4 && a.every(Number.isFinite) ? a : null };
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const MIME = { '.html': 'text/html; charset=utf8', '.js': 'text/javascript; charset=utf8',
  '.css': 'text/css; charset=utf8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon' };

// 读 POST body 的辅助函数
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// 每个 handler 只返回数据：{ json } 或 { csv, name }。写响应由外层负责。
let refreshInFlight = false, refreshStartedAt = 0;
const routes = {
  'GET /api/sources': () => ({ json: {
    groups: registry.groups, kinds: KINDS,
    sources: registry.capabilities().map(s => ({ ...s, health: store.health.get(s.id) || null })),
    http: httpStats(),
  } }),

  'GET /api/events': (q) => ({ json: store.query({
    hours: Math.min(720, Number(q.get('hours') || 24)),
    sources: list(q.get('sources')), kinds: list(q.get('kinds')),
    q: q.get('q') || null, bbox: box(q.get('bbox')),
    limit: Math.min(20000, Number(q.get('limit') || 3000)),
    liveOnly: q.get('live') === '1',
  }) }),

  'GET /api/series': (q) => ({ json: store.series({
    source: q.get('source'), hours: Number(q.get('hours') || 24), buckets: Number(q.get('buckets') || 60),
  }) }),

  'GET /api/stats': () => ({ json: {
    ...store.counts(), now: Math.floor(Date.now() / 1000),
    uptime_s: Math.round((Date.now() - STARTED) / 1000),
    next_wake_ms: nextWake(registry), health: [...store.health],
  } }),

  'GET /api/export.csv': (q) => {
    const { events } = store.query({
      hours: Math.min(720, Number(q.get('hours') || 24)),
      sources: list(q.get('sources')), kinds: list(q.get('kinds')),
      q: q.get('q') || null, limit: 20000,
    });
    const head = 'id,source,kind,event_ts,ingest_ts,lat,lon,weight,title,url,tags\n';
    const body = events.map(e => [e.id, e.source, e.kind, e.ts, e.ingest_ts, e.lat, e.lon, e.weight,
      e.title, e.url, (e.tags || []).join('|')].map(csvCell).join(',')).join('\n');
    return { csv: head + body, name: `intelmap-${new Date().toISOString().slice(0, 10)}.csv` };
  },

  // MCP (Model Context Protocol) 端点：让 Claude / Cursor 等 AI 客户端查询数据
  'POST /mcp': async (q, req) => {
    const body = await readBody(req);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { json: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
    }
    const result = await handleMcp(parsed);
    if (result === null) {
      // notifications/initialized 等无需响应的消息
      return { json: null, status: 202 };
    }
    return { json: result };
  },

  // 手动抓取：GDELT 一轮要 ~100 秒，同步等待会把界面卡死。
  // 默认后台触发立刻返回，前端下一次轮询自然看到新数据。
  'POST /api/refresh': async (q) => {
    const want = list(q.get('source'));
    const targets = want
      ? registry.sources.filter(s => s.runnable && want.includes(s.id)).map(s => s.id)
      : registry.sources.filter(s => s.runnable).map(s => s.id);
    const unknown = (want || []).filter(w => !registry.byId.has(w));
    const opts = { only: want, force: q.get('force') === '1' };
    if (q.get('sync') === '1') {
      const r = await runCycle(registry, opts);
      return { json: { ...r, targets, unknown } };
    }
    if (refreshInFlight) {
      return { json: { scheduled: false, already_running: true, since_ms: Date.now() - refreshStartedAt, targets, unknown } };
    }
    refreshInFlight = true; refreshStartedAt = Date.now();
    runCycle(registry, opts).catch(e => console.error('[refresh] 后台抓取崩了：', e.message))
      .finally(() => { refreshInFlight = false });
    return { json: {
      scheduled: true, targets, unknown,
      note: '后台执行中；受限源（GDELT）约需 1–2 分钟，下次轮询即可看到新事件',
    } };
  },
};


const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // Basic Auth 检查（设了 INTELMAP_AUTH 才启用）
  if (AUTH_HEADER) {
    const auth = req.headers.authorization;
    if (auth !== AUTH_HEADER) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="intelmap"' });
      return res.end('auth required');
    }
  }

  // 浏览器 60 秒轮询 + 用户随时关页面 → 半路断开很常见。
  // 不在这里兜住，写已结束的响应会把整个进程崩掉。
  res.on('error', () => {});
  req.on('error', () => {});
  try {
    const h = routes[`${req.method} ${u.pathname}`];
    if (h) {
      const out = await h(u.searchParams, req);
      if (res.writableEnded || res.destroyed) return;
      if (out.csv !== undefined) {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf8',
          'content-disposition': `attachment; filename="${out.name}"` });
        return res.end(out.csv);
      }
      if (out.status === 202) {
        res.writeHead(202, { 'content-type': 'application/json; charset=utf8' });
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf8',
        'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify(out.json ?? { ok: true }));
    }
    if (u.pathname.startsWith('/api/') || u.pathname === '/mcp') {
      // 路径存在但方法不对时，告诉调用者该用哪个方法 —— 比一句 404 省十分钟
      const samePath = Object.keys(routes).filter(k => k.endsWith(` ${u.pathname}`));
      if (samePath.length) {
        return void jsonError(res, 405, `${req.method} 不支持；${u.pathname} 需要 ${samePath.map(k => k.split(' ')[0]).join(' 或 ')}`);
      }
      return void jsonError(res, 404, `no such endpoint: ${req.method} ${u.pathname}`);
    }

    const p = u.pathname === '/' ? '/index.html' : normalize(u.pathname);
    if (p.includes('..')) { res.writeHead(400); return res.end('nope') }
    const f = join(WEB, p);
    if (!existsSync(f) || !(await stat(f)).isFile()) return void jsonError(res, 404, `not found: ${p}`);
    res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(f));
  } catch (e) {
    console.error('[server]', e.message);
    if (!res.writableEnded && !res.destroyed) jsonError(res, 500, e.message);
  }
});

function jsonError(res, code, msg) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf8', 'access-control-allow-origin': '*' });
  return res.end(JSON.stringify({ error: msg }));
}

if (process.env.NO_INGEST === '1') {
  console.log('[server] NO_INGEST=1 → 只提供 API，抓取交给 cron（node src/refresh.mjs）');
} else {
  loop(registry).catch(e => console.error('[ingest] 循环崩了：', e));
}

server.listen(PORT, HOST, () => {
  const on = registry.sources.filter(s => s.runnable).length;
  const authStatus = AUTH_HEADER ? '已启用 Basic Auth' : '未设鉴权（本地模式）';
  console.log(`\n  intelmap → http://${HOST}:${PORT}`);
  console.log(`  ${on}/${registry.sources.length} 个源已启用（其余缺密钥或非轮询）`);
  console.log(`  MCP 端点 → http://${HOST}:${PORT}/mcp`);
  console.log(`  ${authStatus}\n`);
});
