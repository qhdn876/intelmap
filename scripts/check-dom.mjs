#!/usr/bin/env node
// 没有浏览器时的兜底：核对 app.js 用到的 id 与 class 是否真的存在。
// 这类不一致在浏览器里只会表现成白屏或「点了没反应」，是最难查的一类。
import { readFileSync } from 'node:fs';

const html = readFileSync('web/index.html', 'utf8');
const js = readFileSync('web/app.js', 'utf8');
const css = readFileSync('web/style.css', 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const jsIds = new Set([...js.matchAll(/\$\('#([\w-]+)'\)/g)].map(m => m[1]));
const inlineIds = new Set([...js.matchAll(/id="([\w-]+)"/g)].map(m => m[1]));   // 运行时注入的
const missing = [...jsIds].filter(i => !htmlIds.has(i) && !inlineIds.has(i));

console.log('index.html 的 id ：', [...htmlIds].sort().join(' '));
console.log('app.js   的引用 ：', [...jsIds].sort().join(' '));
console.log('运行时注入的 id ：', [...inlineIds].join(' ') || '—');
console.log('\n✗ 缺失的 id（点了没反应）：', missing.length ? missing.join(' ') : '无');

// class：JS 里赋值的那些，CSS 或 HTML 至少出现一次
const htmlCls = new Set([...html.matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
const jsCls = new Set([
  ...[...js.matchAll(/class="([\w- ]+)"/g)].flatMap(m => m[1].split(/\s+/)),
  ...[...js.matchAll(/el\('[\w]+',\s*'([\w- ]+)'/g)].flatMap(m => m[1].split(/\s+/)),
  ...[...js.matchAll(/'([\w-]+)'\s*\+/g)].map(m => m[1]),
].filter(Boolean));
const cssCls = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map(m => m[1]));
const undef = [...jsCls].filter(c => !cssCls.has(c) && !htmlCls.has(c));
console.log('✗ CSS/HTML 里查无此 class：', undef.length ? undef.join(' ') : '无');

// 交叉核对：/api/xxx 引用是否都在服务端注册
const server = readFileSync('src/server.mjs', 'utf8');
const apiInJs = new Set([...js.matchAll(/\/api\/([\w.-]+)/g)].map(m => '/api/' + m[1]));
const apiInServer = new Set([...server.matchAll(/'(?:GET|POST) (\/api\/[\w.-]+)/g)].map(m => m[1]));
const unhandled = [...apiInJs].filter(a => ![...apiInServer].some(s => s === a || s.startsWith(a)));
console.log('✗ 前端调用但服务端没注册的端点：', unhandled.length ? unhandled.join(' ') : '无');
console.log('服务端端点：', [...apiInServer].sort().join(' '));

process.exit(missing.length || unhandled.length ? 1 : 0);
