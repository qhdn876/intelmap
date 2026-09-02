// 存储：按 kind/入库日 切分的 JSONL + 内存索引。
// 个人规模（每天几千到几万条）下这比数据库省心：grep 能查、坏了删一天重跑、零依赖。
// 要升级到 SQLite/DuckDB，只需替换本文件，其余模块不感知。
//
// 为什么按「入库日」而不是「事件日」分片：
// EONET 的干旱事件 ts 可能是 2019 年。按事件日分片会让它落进窗口外的文件，
// 重启后既不进索引、又因去重集缺失而每轮重复入库。按入库日分片则去重集始终完整。
import { appendFileSync, readFileSync, readdirSync, mkdirSync, existsSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { isLive } from './envelope.mjs';

const ROOT = join(process.cwd(), 'data', 'events');
try { mkdirSync(ROOT, { recursive: true }) } catch {}

const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
// 分片键到 source 一级：不同源的体量差两个数量级（GDELT 4 万条/天 vs 世行 157 条/年），
// 混在一个文件里就没法按源清理 —— 要么全留要么全删，两者都不对。
const fileOf = (kind, source, day) => join(ROOT, kind, source, `${day}.jsonl`);

class Store {
  constructor({ keepDays = 30 } = {}) {
    this.keepDays = keepDays;
    this.bySource = new Map();   // source -> [events]
    this.ids = new Set();
    this.health = new Map();     // source -> {last_run,last_ok,last_err,events,ingests}
    this.loaded = 0;
    try {
      const f = join(process.cwd(), 'data', 'health.json');
      if (existsSync(f)) for (const [k, v] of JSON.parse(readFileSync(f, 'utf8'))) this.health.set(k, v);
    } catch {}
  }

  /** 每个源可以有自己的保留期；没写的用全局 KEEP_DAYS。 */
  keepFor(source) {
    return this.retention?.[source] ?? this.keepDays;
  }
  setRetention(map) { this.retention = map || {}; return this }

  /** 启动时回放保留期内的文件，重建索引。 */
  warm() {
    this.bySource.clear(); this.ids.clear(); this.loaded = 0;
    if (!existsSync(ROOT)) return this;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const kind of readdirSync(ROOT)) {
      const kdir = join(ROOT, kind);
      if (!statSync(kdir).isDirectory()) continue;
      for (const source of readdirSync(kdir)) {
        const dir = join(kdir, source);
        if (!statSync(dir).isDirectory()) continue;
        const cutoff = nowSec - this.keepFor(source) * 86400;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.jsonl')) continue;
          if (Date.parse(f.slice(0, 10)) / 1000 < cutoff) continue;      // 过期分片跳过（prune 会删文件）
          for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
            if (!line.trim()) continue;
            let e; try { e = JSON.parse(line) } catch { continue }
            this._index(e);
          }
        }
      }
    }
    console.log(`[store] 回放 ${this.loaded} 条事件 / ${this.bySource.size} 个源`);
    return this;
  }

  /** 按各源自己的保留期清理磁盘。 */
  prune() {
    const nowSec = Math.floor(Date.now() / 1000);
    let removed = 0;
    if (!existsSync(ROOT)) return 0;
    for (const kind of readdirSync(ROOT)) {
      const kdir = join(ROOT, kind);
      if (!statSync(kdir).isDirectory()) continue;
      for (const source of readdirSync(kdir)) {
        const dir = join(kdir, source);
        if (!statSync(dir).isDirectory()) continue;
        const cutoff = nowSec - this.keepFor(source) * 86400;
        for (const f of readdirSync(dir)) {
          if (!f.endsWith('.jsonl') || Date.parse(f.slice(0, 10)) / 1000 >= cutoff) continue;
          rmSync(join(dir, f)); removed++;
        }
      }
    }
    return removed;
  }

  _index(e) {
    if (this.ids.has(e.id)) return false;
    this.ids.add(e.id);
    const arr = this.bySource.get(e.source) || [];
    arr.push(e);
    this.bySource.set(e.source, arr);
    this.loaded++;
    return true;
  }

  /** 落盘 + 建索引；返回真正新增的事件数（0 表示这轮没有新信号）。 */
  insertMany(events) {
    const byFile = new Map();
    let added = 0;
    for (const e of events) {
      if (this.ids.has(e.id)) continue;
      const key = `${e.kind}|${e.source}|${dayOf(e.ingest_ts)}`;
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(e);
      if (this._index(e)) added++;
    }
    for (const [key, list] of byFile) {
      const [kind, source, day] = key.split('|');
      const f = fileOf(kind, source, day);
      try { mkdirSync(join(ROOT, kind, source), { recursive: true }) } catch {}
      appendFileSync(f, list.map(x => JSON.stringify(x)).join('\n') + '\n');
    }
    return added;
  }

  markRun(source, { ok, error = null, count = 0, added = 0, ms = 0, note = null }) {
    const h = this.health.get(source) || { events: 0, ingests: 0 };
    h.last_run = Date.now();
    if (ok) h.last_ok = Date.now();
    h.last_err = ok ? null : error;
    h.events = this.bySource.get(source)?.length || 0;
    h.ingests = (h.ingests || 0) + 1;
    h.last_ms = ms;
    h.last_count = count;
    h.last_added = added;
    h.note = note;                       // 「为什么这轮是 0 条」
    this.health.set(source, h);
    try { writeFileSync(join(process.cwd(), 'data', 'health.json'), JSON.stringify([...this.health], null, 1)) } catch {}
  }

  /** 查询：时间窗 / 源 / 类型 / 关键词 / 视野框 */
  query({ hours = 24, sources = null, kinds = null, q = null, bbox = null, limit = 2000, liveOnly = false } = {}) {
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    const out = [];
    const srcFilter = sources?.length ? new Set(sources) : null;
    const kindFilter = kinds?.length ? new Set(kinds) : null;
    const needle = q ? q.toLowerCase() : null;
    for (const [source, list] of this.bySource) {
      if (srcFilter && !srcFilter.has(source)) continue;
      for (const e of list) {
        if (e.ts < since) continue;
        if (kindFilter && !kindFilter.has(e.kind)) continue;
        if (liveOnly && !isLive(e)) continue;
        if (needle && !`${e.title} ${e.body} ${(e.tags || []).join(' ')} ${e.region || ''}`.toLowerCase().includes(needle)) continue;
        if (bbox) {
          if (e.lat == null) continue;
          const [w, s, ea, n] = bbox;
          if (e.lon < w || e.lon > ea || e.lat < s || e.lat > n) continue;
        }
        out.push(e);
      }
    }
    out.sort((a, b) => b.ts - a.ts);
    return { events: out.slice(0, limit), total: out.length, truncated: out.length > limit };
  }

  /** 按源聚合的计数分桶，给迷你时间线用 */
  series({ source = null, hours = 24, buckets = 60 } = {}) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - hours * 3600;
    const step = Math.max(60, Math.floor((to - from) / buckets));
    const n = Math.max(1, Math.floor((to - from) / step));
    const series = {};
    for (const [src, list] of this.bySource) {
      if (source && src !== source) continue;
      for (const e of list) {
        if (e.ts < from || e.ts > to) continue;
        const i = Math.min(n - 1, Math.floor((e.ts - from) / step));
        (series[src] ||= Array(n).fill(0))[i]++;
      }
    }
    return { from, to, step, buckets: n, series };
  }

  counts() {
    const kinds = {}, sources = {};
    for (const [src, list] of this.bySource) {
      sources[src] = list.length;
      for (const e of list) kinds[e.kind] = (kinds[e.kind] || 0) + 1;
    }
    return { sources, kinds, total: this.loaded };
  }
}

export const store = new Store({ keepDays: Number(process.env.KEEP_DAYS || 30) });
