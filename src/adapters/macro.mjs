// FRED (Federal Reserve Economic Data) 适配器
// 需要免费 API key: https://fred.stlouisfed.org/docs/api/api_key.html
// TODO: 申请 FRED_KEY 后填入 .env 启用
import { get } from '../http.mjs';

export async function fred({ source, log }) {
  const key = process.env.FRED_KEY;
  if (!key) {
    return { events: [], note: '缺 FRED_KEY，到 https://fred.stlouisfed.org/docs/api/api_key.html 免费申请后填入 .env' };
  }

  const series = source.series || ['FEDFUNDS', 'CPIAUCSL', 'UNRATE', 'DGS10', 'DEXCHUS'];
  const labels = {
    FEDFUNDS: '联邦基金利率',
    CPIAUCSL: 'CPI 通胀',
    UNRATE: '失业率',
    DGS10: '10年期国债收益率',
    DEXCHUS: '人民币/美元汇率',
  };
  const units = {
    FEDFUNDS: '%',
    CPIAUCSL: '',
    UNRATE: '%',
    DGS10: '%',
    DEXCHUS: '',
  };

  const out = [];
  const errors = [];

  for (const sid of series) {
    try {
      const d = await get(
        `${source.url}?series_id=${sid}&api_key=${key}&file_type=json&sort_order=desc&limit=2`,
        { ttl: 21600 }
      );
      const [latest, prev] = d.observations || [];
      if (!latest || latest.value === '.') continue;

      const val = Number(latest.value);
      const prevVal = prev && prev.value !== '.' ? Number(prev.value) : null;
      const change = prevVal !== null ? (val - prevVal).toFixed(2) : null;

      out.push({
        key: `fred:${sid}:${latest.date}`,
        ts: Math.floor(Date.parse(latest.date) / 1000),
        title: `${labels[sid] || sid}: ${val}${units[sid] || ''}${change !== null ? ` (较上期 ${change > 0 ? '+' : ''}${change})` : ''}`,
        tags: ['fred', 'macro', sid],
        weight: 1,
        ttl: 86400 * 30,
        meta: { series: sid, value: val, date: latest.date, change, prev_value: prevVal },
      });
    } catch (e) {
      errors.push(`${sid}: ${e.message}`);
      log?.(`  ! fred/${sid}: ${e.message}`);
    }
  }

  return {
    events: out,
    note: out.length
      ? (errors.length ? `${series.length - errors.length}/${series.length} 个序列成功，失败：${errors[0]}` : null)
      : `FRED ${series.length} 个序列全部失败：${errors[0] || '无数据'} —— 是抓取失败，不是「没有宏观数据」`,
  };
}
