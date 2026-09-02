// 把流式适配器也导出，让 registry 能找到 aisstream_ws
export * from './news.mjs';
export * from './economy.mjs';
export * from './rss.mjs';
export * from './macro.mjs';
export { aisstream_ws } from './stream.mjs';
