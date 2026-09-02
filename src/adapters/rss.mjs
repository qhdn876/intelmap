// 通用 RSS/Atom 适配器：RSSHub 或其他标准 RSS 源。
// 不引入 XML 解析库 —— RSSHub 输出格式稳定，正则够用。
// 如果接非 RSSHub 的源遇到解析问题，再考虑换 xml2js。
import { get } from '../http.mjs';
import { hashId } from '../envelope.mjs';

function parseRSS(xml) {
  const items = [];
  // RSS 2.0 <item>
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  // Atom <entry>
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;

  const extract = (block, tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(block);
    if (!m) return null;
    return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
  };

  const extractLink = (block) => {
    // RSS: <link>url</link>
    let link = extract(block, 'link');
    if (link) return link;
    // Atom: <link href="url" />
    const m = /<link[^>]*href="([^"]+)"/.exec(block);
    return m ? m[1] : null;
  };

  let m;
  while ((m = itemRe.exec(xml))) {
    const block = m[1];
    const title = extract(block, 'title');
    const link = extractLink(block);
    const pubDate = extract(block, 'pubDate') || extract(block, 'published') || extract(block, 'updated');
    const desc = extract(block, 'description') || extract(block, 'summary') || extract(block, 'content');
    if (title && link) items.push({ title, link, pubDate, desc });
  }

  // Atom fallback
  if (!items.length) {
    while ((m = entryRe.exec(xml))) {
      const block = m[1];
      const title = extract(block, 'title');
      const link = extractLink(block);
      const pubDate = extract(block, 'published') || extract(block, 'updated');
      const desc = extract(block, 'summary') || extract(block, 'content');
      if (title && link) items.push({ title, link, pubDate, desc });
    }
  }

  return items;
}

export async function rss_feed({ source, log }) {
  const xml = await get(source.url, { ttl: source.interval || 1800, raw: true });
  const items = parseRSS(xml);
  const now = Math.floor(Date.now() / 1000);
  const maxItems = source.max_items || 20;

  const events = items.slice(0, maxItems).map(it => ({
    key: `rss:${source.id}:${hashId(it.link)}`,
    ts: it.pubDate ? Math.floor(Date.parse(it.pubDate) / 1000) || now : now,
    title: it.title,
    url: it.link,
    body: it.desc ? it.desc.replace(/<[^>]+>/g, '').slice(0, 300) : '',
    tags: ['rss', source.id, ...(source.tags || [])],
    weight: source.weight || 1,
    ttl: source.ttl || 86400 * 3,
    meta: { feed: source.id, raw_date: it.pubDate },
  }));

  return {
    events,
    note: events.length
      ? null
      : `${source.label || source.id} 返回 0 条（RSSHub 实例可能挂了或路由失效）`,
  };
}
