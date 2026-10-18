/* SPDX-License-Identifier: MIT */
/**
 * 调用日志（细粒度审计）
 *  - 存储：DATA_DIR/logs/YYYY-MM-DD.jsonl，按本地日期切分，保留 MAX_DAYS 天
 *  - 记录两类：
 *      kind='mcp'   MCP 请求（initialize / tools/list / tools/call…），含工具名、参数、鉴权方式、key 名称、耗时、结果
 *      kind='admin' 管理操作（登录 / 改密钥 / 扫码 / 吊销 / key 增删…）
 *  - 查询：query({ limit, offset, days, kind, ok, tool, q }) 倒序返回 { total, items }
 *  - 统计：stats({ days }) 聚合总数 / 成功率 / 平均耗时 / 按工具分布
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.GOOFISH_DATA_DIR || '/home/ant/service/goofish-mcp/data';
const LOG_DIR = path.join(DATA_DIR, 'logs');
const MAX_DAYS = 7;

function pad(n) { return String(n).padStart(2, '0'); }

function dayStr(d = new Date()) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function logFileFor(d) {
  return path.join(LOG_DIR, dayStr(d) + '.jsonl');
}

function log(entry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const row = { ts: new Date().toISOString(), ip: entry.ip || '-', kind: entry.kind || 'mcp', ...entry };
    fs.appendFileSync(logFileFor(), JSON.stringify(row) + '\n');
  } catch (e) {
    console.error('logger: write failed:', e.message);
  }
}

function readDays(days = 2) {
  const out = [];
  const now = new Date();
  const span = Math.min(MAX_DAYS, Math.max(1, days));
  for (let i = 0; i < span; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const f = logFileFor(d);
    if (!fs.existsSync(f)) continue;
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { /* skip bad line */ }
    }
  }
  out.reverse(); // 最新在前
  return out;
}

function query({ limit = 50, offset = 0, days = 2, kind, ok, tool, q } = {}) {
  let rows = readDays(days);
  if (kind === 'mcp' || kind === 'admin') rows = rows.filter((r) => r.kind === kind);
  if (ok === true || ok === false) rows = rows.filter((r) => !!r.ok === ok);
  if (tool) rows = rows.filter((r) => r.tool === tool);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
  }
  const total = rows.length;
  const items = rows.slice(offset, offset + Math.min(500, Math.max(1, limit)));
  return { total, items };
}

function stats(days = 7) {
  const rows = readDays(days);
  const today = dayStr();
  const total = rows.length;
  const okCount = rows.filter((r) => r.ok).length;
  const todayCount = rows.filter((r) => (r.ts || '').startsWith(today)).length;
  const mcpRows = rows.filter((r) => r.kind === 'mcp');
  const msList = mcpRows.map((r) => r.ms).filter((n) => typeof n === 'number' && n >= 0);
  const avgMs = msList.length ? Math.round(msList.reduce((a, b) => a + b, 0) / msList.length) : 0;
  const byTool = {};
  for (const r of mcpRows) {
    const t = r.tool || r.action || '(other)';
    byTool[t] = (byTool[t] || 0) + 1;
  }
  return {
    total,
    okCount,
    failCount: total - okCount,
    successRate: total ? Math.round((okCount / total) * 100) : 0,
    todayCount,
    avgMs,
    byTool: Object.entries(byTool).map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
  };
}

function cleanup() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const cutoff = Date.now() - MAX_DAYS * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = f.match(/^(\d{4})-(\d{2})-(\d{2})\.jsonl$/);
      if (!m) continue;
      const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
      if (t < cutoff) fs.unlinkSync(path.join(LOG_DIR, f));
    }
  } catch (e) { /* ignore */ }
}

module.exports = { log, query, stats, cleanup, LOG_DIR };
