// 统一导出所有适配器。registry 按 sources.json 里的 adapter 字段查找。
// natural/aviation 的源目前在 sources.json 里被删了（个人不需要灾害/空域监控），
// 但适配器保留导出：想加回来只需在 sources.json 里加条目，不用改代码。
export * from './natural.mjs';
export * from './aviation.mjs';
export * from './news.mjs';
export * from './economy.mjs';
export * from './rss.mjs';
export * from './macro.mjs';
export { aisstream_ws } from './stream.mjs';