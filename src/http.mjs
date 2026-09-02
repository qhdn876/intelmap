// 抓取 + 协商缓存 + 重试 + 退避。所有出站请求走这里，一处解决 UA / 超时 / 限速 / 新鲜度记录。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 注意：MET Norway 会拒绝含 email 字样的 User-Agent（实测 `intelmap/0.1 contact you@example.com`
// 直接 403，换成 URL 形式就 200）。所以这里用 URL 而不是 mailto。
export const UA = process.env.HTTP_UA || 'intelmap/0.1 (+https://github.com/you/intelmap)';

const CACHE = join(process.cwd(), 'data', 'http-cache');
const STATE = join(process.cwd(), 'data', 'http-state.json');
try { mkdirSync(CACHE, { recursive: true }) } catch {}

const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return {} } };
const save = (s) => { try { writeFileSync(STATE, JSON.stringify(s)) } catch {} };
const state = load();

export class HttpError extends Error {
  constructor(msg, { status, url, retryAfter } = {}) {
    super(msg);
    this.status = status; this.url = url; this.retryAfter = retryAfter;
  }
}

const cacheFile = (url) => join(CACHE, url.replace(/[^\w.-]/g, '_').slice(0, 180));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * GET 一个 URL。
 *  - 自动带 ETag / If-Modified-Since，304 时直接吃本地缓存副本（省流量，也避免打爆免费额度）
 *  - ttl 秒内的重复调用直接返回缓存，不发请求
 *  - 失败时记录到 data/http-state.json，供健康面板展示
 */
export async function get(url, { timeout = 15000, ttl = 0, headers = {}, raw = false, method = 'GET', body = null } = {}) {
  const st = (state[url] ||= { hits: 0, fails: 0, last_ok: 0, last_err: null });
  const file = cacheFile(url);

  if (ttl && existsSync(file) && st.cached_at && Date.now() - st.cached_at < ttl * 1000) {
    st.served_from_ttl = (st.served_from_ttl || 0) + 1;
    const text = readFileSync(file, 'utf8');
    return raw ? text : JSON.parse(text || 'null');
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const h = { 'user-agent': UA, accept: raw ? '*/*' : 'application/json, text/plain, */*', ...headers };
  if (st.etag) h['if-none-match'] = st.etag;
  if (st.modified) h['if-modified-since'] = st.modified;

  try {
    const res = await fetch(url, { headers: h, signal: ctl.signal, redirect: 'follow', method, body });

    if (res.status === 304 && existsSync(file)) {
      st.hits++; st.last_ok = Date.now(); save(state);
      const text = readFileSync(file, 'utf8');
      return raw ? text : JSON.parse(text || 'null');
    }
    if (!res.ok) {
      st.fails++; st.last_err = `${res.status} ${res.statusText || ''}`.trim(); save(state);
      throw new HttpError(`HTTP ${res.status} ${res.statusText || ''}`, {
        status: res.status, url, retryAfter: Number(res.headers.get('retry-after')) || null,
      });
    }
    const text = await res.text();
    if (!text.trim()) {
      st.fails++; st.last_err = 'empty body'; save(state);
      throw new HttpError('空响应体', { status: 200, url });
    }
    st.etag = res.headers.get('etag') || st.etag;
    st.modified = res.headers.get('last-modified') || st.modified;
    st.hits++; st.fails = 0; st.last_ok = Date.now(); st.last_err = null; st.cached_at = Date.now();
    try { writeFileSync(file, text) } catch {}
    save(state);
    if (raw) return text;
    try { return JSON.parse(text) } catch {
      throw new HttpError(`期望 JSON，收到: ${text.slice(0, 80)}`, { status: 200, url });
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      st.fails++; st.last_err = `timeout ${timeout}ms`; save(state);
      throw new HttpError(`超时 ${timeout}ms`, { url });
    }
    if (e instanceof HttpError) throw e;
    st.fails++; st.last_err = e.message; save(state);
    throw new HttpError(e.message, { url });
  } finally {
    clearTimeout(timer);
  }
}

/** 连续失败时指数退避，别把免费源打进封禁。 */
export function backoffFor(url) {
  const st = state[url];
  if (!st?.last_err || !st.fails) return 0;
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.min(st.fails - 1, 6));
}

export const stats = () => state;
