// MCP (Model Context Protocol) server 端点
// 让 Claude / Cursor / 其他 MCP 客户端能查询 intelmap 的数据
// 协议：JSON-RPC 2.0 over HTTP POST (Streamable HTTP transport)
// 参考：https://modelcontextprotocol.io/specification/2025-03-26

const TOOLS = [
  {
    name: 'query_events',
    description: '查询事件流。按时间窗、数据源、类型、关键词、地理范围过滤。返回结构化事件列表。',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: '时间窗（小时），默认 24，最大 720' },
        sources: { type: 'string', description: '数据源 ID，逗号分隔，如 "gdelt_events,wallstreetcn_hot"' },
        kinds: { type: 'string', description: '事件类型，逗号分隔，如 "news,macro,market"' },
        q: { type: 'string', description: '关键词搜索（标题/正文/标签）' },
        bbox: { type: 'string', description: '地理范围，格式 "west,south,east,north"，如 "100,18,145,46"（东亚）' },
        limit: { type: 'number', description: '返回条数上限，默认 50，最大 200' },
        live: { type: 'boolean', description: '只返回未过期事件' },
      },
    },
  },
  {
    name: 'get_source_health',
    description: '查看所有数据源的运行状态：上次抓取时间、条数、错误信息。用于判断哪些源在正常工作。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_timeline',
    description: '获取指定数据源的时间线数据（按时间桶聚合的事件计数），用于趋势分析。',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: '数据源 ID，如 "gdelt_timeline"' },
        hours: { type: 'number', description: '时间窗（小时），默认 24' },
        buckets: { type: 'number', description: '时间桶数量，默认 60' },
      },
      required: ['source'],
    },
  },
  {
    name: 'list_sources',
    description: '列出所有已配置的数据源及其能力（类型、更新周期、是否需要密钥、是否可用）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_stats',
    description: '获取系统整体统计：总事件数、各源条数、运行时长、下次抓取时间。',
    inputSchema: { type: 'object', properties: {} },
  },
];

export function createMcpHandler({ store, registry, KINDS }) {
  const list = (v) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : null);
  const box = (v) => { const a = list(v)?.map(Number); return a?.length === 4 && a.every(Number.isFinite) ? a : null };

  async function handleToolCall(name, args) {
    switch (name) {
      case 'query_events': {
        const result = store.query({
          hours: Math.min(720, Number(args.hours || 24)),
          sources: list(args.sources),
          kinds: list(args.kinds),
          q: args.q || null,
          bbox: args.bbox ? box(args.bbox) : null,
          limit: Math.min(200, Number(args.limit || 50)),
          liveOnly: args.live === true,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'get_source_health': {
        const health = [...store.health].map(([id, h]) => ({
          source: id,
          last_run: h.last_run ? new Date(h.last_run).toISOString() : null,
          last_ok: h.last_ok ? new Date(h.last_ok).toISOString() : null,
          last_error: h.last_err,
          events_in_memory: h.events,
          total_ingests: h.ingests,
          last_fetch_ms: h.last_ms,
          last_count: h.last_count,
          last_added: h.last_added,
          note: h.note,
        }));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(health, null, 2),
          }],
        };
      }

      case 'get_timeline': {
        if (!args.source) throw new Error('source is required');
        const result = store.series({
          source: args.source,
          hours: Number(args.hours || 24),
          buckets: Number(args.buckets || 60),
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      }

      case 'list_sources': {
        const sources = registry.capabilities().map(s => ({
          ...s,
          health: store.health.get(s.id) || null,
        }));
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ groups: registry.groups, kinds: KINDS, sources }, null, 2),
          }],
        };
      }

      case 'get_stats': {
        const stats = {
          ...store.counts(),
          now: Math.floor(Date.now() / 1000),
          sources_configured: registry.sources.length,
          sources_runnable: registry.sources.filter(s => s.runnable).length,
        };
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(stats, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // JSON-RPC 2.0 handler
  return async function handleMcp(body) {
    const { jsonrpc, id, method, params } = body;

    if (jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request: jsonrpc must be "2.0"' } };
    }

    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-03-26',
              capabilities: { tools: {} },
              serverInfo: { name: 'intelmap', version: '0.2.0' },
            },
          };

        case 'notifications/initialized':
          // 客户端确认初始化完成，无需响应
          return null;

        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: { tools: TOOLS },
          };

        case 'tools/call': {
          const { name, arguments: args } = params || {};
          if (!name) throw new Error('Missing tool name');
          const result = await handleToolCall(name, args || {});
          return { jsonrpc: '2.0', id, result };
        }

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (e) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: e.message },
      };
    }
  };
}
