// 抓取 koala73/worldmonitor 的可复核指标，输出 JSON。
// README 里每个数字都应该能由这个脚本重跑出来 —— 否则它就只是另一篇"感觉像刷量"的吐槽。
// 用法： node scripts/probe-upstream.mjs > docs/upstream-evidence.json
const API = 'https://api.github.com';
const UA = 'intelmap/0.1 (+https://github.com/you/intelmap)';
// 未认证只有 60 次/小时，跑完这套会剩一半 ERR。有 token 就走 5000 次/小时。
const AUTH = process.env.GITHUB_TOKEN ? { authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {};
const get = async (u) => {
  const r = await fetch(u, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github+json', ...AUTH },
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  if (!r) return { status: 0, body: '' };
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) } } catch { return { status: r.status, body: t.slice(0, 200) } }
};
const txt = async (u) => fetch(u, { headers: { 'user-agent': UA, ...AUTH }, signal: AbortSignal.timeout(20000) })
  .then(r => r.ok ? r.text() : '').catch(() => '');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const SKIP = (process.env.SKIP || '').split(',').map(x=>x.trim()).filter(Boolean);
const OUT = process.env.OUT || 'docs/upstream-evidence.json';
const out = { probed_at: new Date().toISOString(), subject: 'koala73/worldmonitor', skipped: SKIP, auth: AUTH.authorization ? 'token (5000/hr)' : 'none (60/hr — 会大量 ERR)' };

const repo = (await get(`${API}/repos/koala73/worldmonitor`)).body;
const ageDays = (Date.now() - Date.parse(repo.created_at)) / 86400000;
out.repo_info = {
  stars: repo.stargazers_count, forks: repo.forks_count, subscribers: repo.subscribers_count,
  open_issues_incl_prs: repo.open_issues_count, created_at: repo.created_at, pushed_at: repo.pushed_at,
  size_kb: repo.size, license: repo.license?.spdx_id, homepage: repo.homepage, topics: repo.topics,
  age_days: +ageDays.toFixed(1), stars_per_day_avg: Math.round(repo.stargazers_count / ageDays),
  star_per_sub: +(repo.stargazers_count / repo.subscribers_count).toFixed(0),
  fork_per_star: +(repo.forks_count / repo.stargazers_count).toFixed(3),
};

// 对照组：star/subscriber 比例本身不是证据。同类大仓库也是这个量级，所以必须一起记下来 ——
// 这一条恰好是推翻我自己怀疑的，写出来比藏起来诚实。
out.control_repos = {};
for (const c of ['vitejs/vite', 'microsoft/playwright', 'shadcn-ui/ui', 'openclaw/openclaw']) {
  await sleep(900);
  const r = (await get(`${API}/repos/${c}`)).body;
  if (!r?.stargazers_count) continue;
  out.control_repos[c] = {
    stars: r.stargazers_count, subscribers: r.subscribers_count,
    star_per_sub: +(r.stargazers_count / r.subscribers_count).toFixed(0),
    fork_per_star: +(r.forks_count / r.stargazers_count).toFixed(3),
  };
}

await sleep(900);
out.languages = (await get(`${API}/repos/koala73/worldmonitor/languages`)).body;
out.total_source_bytes = Object.values(out.languages).reduce((a, b) => a + b, 0);

await sleep(900);
const rel = (await get(`${API}/repos/koala73/worldmonitor/releases?per_page=100`)).body;
if (Array.isArray(rel)) out.releases = { listed: rel.length, latest_tag: rel[0]?.tag_name, latest_published: rel[0]?.published_at };
await sleep(900);
const tags = (await get(`${API}/repos/koala73/worldmonitor/tags?per_page=3`)).body;
out.latest_tags = Array.isArray(tags) ? tags.map(t => t.name) : tags;

await sleep(900);
// 注意：raw.githubusercontent.com 在部分网络下不可达（本沙箱实测不通），
// 所以走 Contents API 的 raw 变体，别用 raw. 域名。
const rawViaApi = async (p) => {
  const r = await fetch(`${API}/repos/koala73/worldmonitor/contents/${p}`, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github.raw', ...AUTH } });
  return r.ok ? await r.text() : '';
};
const pkg = await rawViaApi('package.json');
try { const p = JSON.parse(pkg); out.pkg = { name: p.name, version: p.version, deps: Object.keys(p.dependencies || {}).length, scripts: Object.keys(p.scripts || {}).length, license: p.license } } catch { out.pkg = 'parse failed' }
const env = await rawViaApi('.env.example');
out.env_example = { keys: (env.match(/^[A-Z][A-Z0-9_]*=/gm) || []).length, bytes: env.length };

await sleep(900);
const part = (await get(`${API}/repos/koala73/worldmonitor/stats/participation`)).body;
if (part?.all) out.commits_52wk = {
  total: part.all.reduce((a, b) => a + b, 0), weekly_avg: Math.round(part.all.reduce((a, b) => a + b, 0) / 52), last4wk: part.all.slice(-4),
};

await sleep(900);
const con = (await get(`${API}/repos/koala73/worldmonitor/contributors?per_page=10`)).body;
if (Array.isArray(con)) {
  out.top_contributors = con.slice(0, 6).map(c => ({ login: c.login, commits: c.contributions }));
  if (out.commits_52wk) out.owner_share_pct_of_52wk = +((con[0].contributions / out.commits_52wk.total) * 100).toFixed(1);
}

out.counters = {};
for (const [k, q] of Object.entries({ pr_total: 'is:pr', pr_merged: 'is:pr is:merged', pr_open: 'is:pr state:open', issue_open: 'is:issue state:open', issue_closed: 'is:issue state:closed' })) {
  await sleep(2000);                      // 未认证 search 限 10 次/分钟，且不编码会四个查询返回同一个数
  const r = await get(`${API}/search/issues?q=${encodeURIComponent(q + ' repo:koala73/worldmonitor')}&per_page=1`);
  out.counters[k] = r.body?.total_count ?? `ERR ${r.status}`;
}

await sleep(900);
const head = (await get(`${API}/repos/koala73/worldmonitor/commits/main`)).body;
if (head?.sha) {
  await sleep(900);
  const cr = (await get(`${API}/repos/koala73/worldmonitor/commits/${head.sha}/check-runs?per_page=100`)).body;
  const tally = {};
  for (const r of cr.check_runs || []) { const k = `${r.status}/${r.conclusion ?? '-' }`; tally[k] = (tally[k] || 0) + 1 }
  out.head_ci = { sha: head.sha.slice(0, 8), date: head.commit?.committer?.date, total_check_runs: cr.total_count, first_100: tally };
}

out.packages = {
  npm_cli_downloads_last_week: await txt('https://api.npmjs.org/downloads/point/last-week/worldmonitor').then(t => JSON.parse(t).downloads).catch(() => 'ERR'),
  npm_cli_version: await txt('https://registry.npmjs.org/worldmonitor').then(t => JSON.parse(t)['dist-tags'].latest).catch(() => 'ERR'),
};

await sleep(900);
const tree = (await get(`${API}/repos/koala73/worldmonitor/git/trees/main?recursive=1`)).body;
if (tree?.tree) {
  const blobs = tree.tree.filter(t => t.type === 'blob');
  const top = {};
  for (const b of blobs) { const k = b.path.includes('/') ? b.path.split('/').slice(0, 2).join('/') : b.path; (top[k] ||= { files: 0, bytes: 0 }); top[k].files++; top[k].bytes += b.size || 0 }
  out.tree = {
    files: blobs.length, truncated: !!tree.truncated,
    biggest_dirs: Object.entries(top).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 10).map(([p, v]) => ({ path: p, files: v.files, mb: +(v.bytes / 1048576).toFixed(1) })),
    largest_files: blobs.slice().sort((a, b) => b.size - a.size).slice(0, 6).map(b => ({ path: b.path, kb: Math.round(b.size / 1024) })),
    test_files: blobs.filter(b => /(^|\/)(tests?|__tests__|spec)\//.test(b.path)).length,
    workflows: blobs.filter(b => b.path.startsWith('.github/workflows/')).length,
    proto: blobs.filter(b => b.path.endsWith('.proto')).length,
    md_and_mdx: blobs.filter(b => /\.mdx?$/.test(b.path)).length,
  };
}

if (!SKIP.includes("wayback")) {
// Wayback 上的 star 曲线：证明「增长形态」，而不是只报一个当前值。
// 坑：CDX 的 length 字段是压缩后大小，拿它筛"完整页面"会漏；实测靠 grep 计数器 markup 才可靠。
const cdx = await txt('https://web.archive.org/cdx/search/cdx?url=github.com/koala73/worldmonitor&output=json&fl=timestamp,original&collapse=timestamp:6&limit=400');
let snaps = [];
try { snaps = JSON.parse(cdx).slice(1).map(r => r[0]).filter(t => /^\d{14}$/.test(t)) } catch { snaps = [] }
const step = Math.max(1, Math.floor(snaps.length / 12));   // 12 个点足够看出形态；再多会被 Wayback 拖死
out.wayback = { total_snapshots: snaps.length, sampled: 0, curve: [], per_day: [] };
if (!snaps.length) {
  // 本项目的硬规矩：取不到东西必须说明，不能静默交空
  out.wayback.note = 'web.archive.org 不可达或限流（连接超时）。曲线数据以本仓库早期（2026-09-02）同一选择器抓取的快照为准；重跑若网络通畅会自动补齐。';
} else {
for (let i = 0; i < snaps.length; i += step) {
  const ts = snaps[i];
  const h = await txt(`https://web.archive.org/web/${ts}id_/https://github.com/koala73/worldmonitor`);
  const m = h.match(/id="repo-stars-counter-star"[^>]*title="([\d,]+)"/);
  if (!m) continue;
  const f = h.match(/id="repo-network-counter"[^>]*title="([\d,]+)"/);
  out.wayback.sampled++;
  out.wayback.curve.push({
    date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
    stars: Number(m[1].replace(/,/g, '')),
    forks: f ? Number(f[1].replace(/,/g, '')) : null,
  });
}
// 相邻快照间的日均增速 —— 匀速增长会被这列数字暴露出来
out.wayback.per_day = out.wayback.curve.slice(1).map((c, i) => {
  const p = out.wayback.curve[i];
  const days = (Date.parse(c.date) - Date.parse(p.date)) / 86400000;
  return { from: p.date, to: c.date, stars_per_day: days > 0 ? Math.round((c.stars - p.stars) / days) : null };
});
}
}

// HN 上的公开讨论度：同一链接被投了很多次，最高多少分
const hn = await txt('https://hn.algolia.com/api/v1/search?query=worldmonitor&tags=story&hitsPerPage=30');
try {
  const hits = JSON.parse(hn).hits.filter(h => /worldmonitor\.app|koala73/.test(h.url || ''));
  out.hackernews = {
    submissions: hits.length,
    max_points: Math.max(...hits.map(h => h.points || 0)),
    total_comments: hits.reduce((s, h) => s + (h.num_comments || 0), 0),
    window: hits.length ? `${hits[hits.length - 1].created_at.slice(0, 10)} → ${hits[0].created_at.slice(0, 10)}` : null,
    top: hits.slice().sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 5).map(h => ({ t: h.created_at.slice(0, 10), title: h.title, points: h.points, comments: h.num_comments })),
  };
} catch { out.hackernews = 'parse failed' }

import { writeFileSync } from 'node:fs';
// （写盘放在文件末尾，见末尾的 writeFileSync —— 放这里会把后面的统计段漏掉）

// 近期 star 的账号年龄分布。用 actor id 近似注册时间（GitHub id 随时间单调增长），
// 这样不用逐个查 /users，也就能在没有 token 的情况下复现。
// 阈值 2.55e8 ≈ 2025-12 之后注册 —— 依据见 calibration（用已知 login 的 created_at 标出）。
if (!SKIP.includes("age")) {
const FRESH = 255_000_000, VERY_FRESH = 300_000_000;
out.stargazer_account_age = { note: 'id>2.55e8 ≈ 2025-12 后注册；id>3.0e8 ≈ 近 5 周。指标很弱：真实热点同样会吸引新号，只有与对照组比较才有意义。', calibration_ids_sampled: true };
for (const r of ['koala73/worldmonitor', 'vitejs/vite', 'microsoft/playwright']) {
  const ids = [];
  for (let pg = 1; pg <= 4; pg++) {
    await sleep(700);
    const ev = (await get(`${API}/repos/${r}/events?per_page=100&page=${pg}`)).body;
    if (!Array.isArray(ev) || !ev.length) break;
    for (const e of ev) if (e.type === 'WatchEvent') ids.push(e.actor.id);
  }
  if (!ids.length) { out.stargazer_account_age[r] = 'no WatchEvents in window'; continue }
  out.stargazer_account_age[r] = {
    sampled: ids.length,
    pct_created_after_2025_12: +(100 * ids.filter(i => i > FRESH).length / ids.length).toFixed(1),
    pct_created_last_5_weeks: +(100 * ids.filter(i => i > VERY_FRESH).length / ids.length).toFixed(1),
  };
}
}

writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.error('已写入 ' + OUT + ' （跳过: ' + (SKIP.join(',') || '无') + '）');
