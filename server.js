#!/usr/bin/env node
/**
 * goofish-mcp — 闲鱼只读查询 MCP server（HTTP / Streamable + OAuth）
 *
 * 工具：
 *  - search_items:      按关键词搜索闲鱼商品（匿名，无需登录）
 *  - get_item_detail:   获取商品详情（匿名，无需登录）
 *
 * 传输：MCP over Streamable HTTP（stateless，无会话状态）
 * 端点：
 *  - POST /mcp  —— 所有 MCP 工具/初始化请求
 *  - GET  /mcp  —— 405（stateless 不支持 SSE 流）
 *  - GET  /health —— 健康检查（无需鉴权，用于探活）
 *
 * 鉴权（/mcp 两种都放行）：
 *  - 静态 key：请求头 `Authorization: Bearer <GOOFISH_API_KEY>` 或 `x-api-key: <GOOFISH_API_KEY>`
 *  - OAuth token：`Authorization: Bearer <access_token>`（由本服务签发，PKCE 授权码流程）
 *
 * OAuth 授权码端点（面向 ChatGPT 等 OAuth 客户端）：
 *  - GET  /.well-known/oauth-authorization-server  —— RFC 8414 metadata
 *  - GET  /.well-known/oauth-protected-resource/mcp —— RFC 9728 PRM
 *  - GET/POST /authorize   —— 授权码发放（自动批准）
 *  - POST /token           —— 授权码换 token / refresh
 *  - POST /register        —— 动态客户端注册
 *  - POST /revoke          —— token 撤销
 *
 * 依赖：goofish-client 本地构建（/home/ant/dev/goofish-client/dist）
 */
const path = require('path');
const { z } = require('zod');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createMcpExpressApp } = require('@modelcontextprotocol/sdk/server/express.js');
const { mcpAuthRouter, createOAuthMetadata } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { PersistentOAuthProvider } = require('./oauth-provider.js');

const GOOFISH_DIST = process.env.GOOFISH_CLIENT_DIST ||
  '/home/ant/dev/goofish-client/dist/index.js';
const { Goofish, LogLevel } = require(GOOFISH_DIST);

const PORT = Number(process.env.GOOFISH_PORT) || 8670;
const HOST = process.env.GOOFISH_HOST || '127.0.0.1';
const API_KEY = (process.env.GOOFISH_API_KEY || '').trim();
// OAuth issuer（必须是 https 公网地址，SDK 强制校验）
const ISSUER = process.env.GOOFISH_ISSUER || 'https://MCP_HOST_EXAMPLE.com';

// 单例 OAuth provider（内存 + 磁盘持久化）
let _oauthAuth = null;
function getOAuthProvider() {
  if (!_oauthAuth) _oauthAuth = new PersistentOAuthProvider();
  return _oauthAuth;
}

// 静态 key 校验
function matchesApiKey(req) {
  if (!API_KEY) return false;
  const header =
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim() ||
    (req.headers['x-api-key'] || '').trim() ||
    (req.headers['x-api-token'] || '').trim();
  return header === API_KEY;
}

// 校验 Bearer token：静态 key 优先，否则走 OAuth 校验
async function isAuthorized(req) {
  if (matchesApiKey(req)) return true;
  const header = (req.headers['authorization'] || '').trim();
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const token = m[1].trim();
  if (!token) return false;
  try {
    const info = await getOAuthProvider().verifyAccessToken(token);
    return !!info.token;
  } catch (e) {
    return false;
  }
}

// 单例 client（复用匿名 token，避免每次重建触发多次"令牌为空"重试）
let _client = null;
function getClient() {
  if (!_client) {
    _client = new Goofish({ level: LogLevel.ERROR });
  }
  return _client;
}

// 从一条搜索结果里稳妥提取 itemId（clickParam 里带 itemId）
function extractItemId(entry) {
  if (!entry || !entry.data) return null;
  const item = entry.data.item || {};
  if (item.itemId) return String(item.itemId);
  if (item.clickParam) {
    const m = String(item.clickParam).match(/itemId"?\s*[:=]\s*"?(\d+)"?/);
    if (m) return m[1];
  }
  const str = JSON.stringify(item);
  const m = str.match(/"itemId"\s*:\s*"?(\d+)"?/);
  return m ? m[1] : null;
}

// 格式化一条搜索结果的 title/price/desc
function formatResult(entry) {
  const item = (entry && entry.data && entry.data.item) || {};
  const ex = item.main && item.main.exContent;
  const title = ex && ex.title ? ex.title : '';
  const price = (ex && ex.price ? ex.price.map((p) => p.text).join('') : '');
  const desc = (ex && ex.desc) || '';
  const itemId = extractItemId(entry);
  return { itemId, title, price, desc };
}

const server = new McpServer({
  name: 'goofish',
  version: '1.0.0',
});

server.registerTool('search_items', {
  title: '搜索闲鱼商品',
  description: '按关键词搜索闲鱼(Goofish)二手商品，匿名可用。返回商品标题、价格、描述和 itemId。可传价格区间、排序、快速筛选(个人闲置/验货宝等)。',
  inputSchema: {
    keyword: z.string().describe('搜索关键词，如 "MacBook Pro M1"'),
    page: z.number().optional().describe('页码，从 1 开始，默认 1'),
    rows: z.number().optional().describe('每页数量，默认 20，建议 5-20'),
    min_price: z.number().optional().describe('最低价筛选（可选）'),
    max_price: z.number().optional().describe('最高价筛选（可选）'),
    sort: z.enum(['price_asc', 'price_desc', 'newest']).optional().describe('排序，可选 price_asc / price_desc / newest（默认按综合）'),
    personal: z.boolean().optional().describe('只看个人闲置（filterPersonal，排除商家）'),
    appraise: z.boolean().optional().describe('只看验货宝商品（filterAppraise，更有保障）'),
  },
}, async (input) => {
  try {
    const client = getClient();
    const params = {
      keyword: input.keyword,
      pageNumber: input.page || 1,
      rowsPerPage: input.rows || 20,
      sortValue: input.sort === 'price_asc' ? 'asc' : input.sort === 'price_desc' ? 'desc' : undefined,
      sortField: input.sort === 'price_asc' || input.sort === 'price_desc' ? 'price' : undefined,
      filter: {},
    };
    if (input.min_price != null || input.max_price != null) {
      params.filter.priceRange = {
        from: input.min_price != null ? input.min_price : 0,
        to: input.max_price,
      };
    }
    const qf = [];
    if (input.personal) qf.push('filterPersonal');
    if (input.appraise) qf.push('filterAppraise');
    if (qf.length) params.filter.quickFilters = qf;
    const res = await client.api.mtop.search.search(params);
    if (!res || res.ret[0] !== 'SUCCESS::调用成功' || !res.data) {
      return { content: [{ type: 'text', text: '搜索失败: ' + JSON.stringify(res && res.ret) }] };
    }
    const list = res.data.resultList || [];
    const items = list.map(formatResult).filter((x) => x.title || x.itemId);
    const total = res.data.total || items.length;
    const text = items.length
      ? `共约 ${total} 条，本次返回 ${items.length} 条：\n\n` +
        items.map((it, i) =>
          `${i + 1}. [${it.itemId || '-'}] ${it.title}\n   价格: ${it.price || '-'}`
        ).join('\n')
      : '未找到商品。';
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    return { content: [{ type: 'text', text: '搜索异常: ' + (e && e.message) }] };
  }
});

server.registerTool('get_item_detail', {
  title: '获取闲鱼商品详情',
  description: '通过 itemId 获取闲鱼商品完整详情（标题、价格、描述、卖家、浏览/收藏数、图片数等），匿名可用。',
  inputSchema: {
    item_id: z.string().describe('商品 ID，如 1045859220365（可来自 search_items 结果）'),
  },
}, async (input) => {
  try {
    const client = getClient();
    const res = await client.api.mtop.item.getDetail({ itemId: input.item_id });
    if (!res || res.ret[0] !== 'SUCCESS::调用成功' || !res.data) {
      return { content: [{ type: 'text', text: '详情获取失败: ' + JSON.stringify(res && res.ret) }] };
    }
    const itemDO = res.data.itemDO || {};
    const sellerDO = res.data.sellerDO || {};
    const lines = [
      `标题: ${itemDO.title || '-'}`,
      `价格: ${itemDO.soldPrice || '-'}`,
      `描述: ${(itemDO.desc || '').slice(0, 2000)}`,
      `浏览: ${itemDO.browseCnt || 0} | 收藏: ${itemDO.collectCnt || 0}`,
      `卖家: ${sellerDO.nick || '-'}`,
      `图片数: ${(itemDO.imageInfos || []).length}`,
      `链接: ${(itemDO.shareInfoJsonString || '') ? '见图片/hitNativeDetail' : ''}`,
    ].filter(Boolean);
    const imageUrls = (itemDO.imageInfos || []).map(img => img?.url).filter(Boolean);
    if (imageUrls.length) {
      lines.push('图片URL:');
      for (const u of imageUrls) lines.push(`- ${u}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: '详情异常: ' + (e && e.message) }] };
  }
});

const app = createMcpExpressApp({
  host: HOST,
  // 放行公网域名，否则 DNS rebinding 防护会拦截 nginx 转发的公网 Host
  allowedHosts: ['MCP_HOST_EXAMPLE.com', 'localhost', '127.0.0.1', '::1'],
});

// ---- OAuth 授权码服务器（挂载到 app 根）----
const oauthProvider = getOAuthProvider();
const issuerUrl = new URL(ISSUER);
// 后台自动批准、免人工登录，PKCE 由 SDK token handler 校验
app.use(mcpAuthRouter({
  provider: oauthProvider,
  issuerUrl,
  baseUrl: issuerUrl,
  scopesSupported: ['mcp:tools'],
}));
const oauthMetadata = createOAuthMetadata({
  provider: oauthProvider,
  issuerUrl,
  baseUrl: issuerUrl,
  scopesSupported: ['mcp:tools'],
});
console.error('goofish-mcp OAuth issuer:', oauthMetadata.issuer);
console.error('  authorize:', oauthMetadata.authorization_endpoint);
console.error('  token:   ', oauthMetadata.token_endpoint);
console.error('  register:', oauthMetadata.registration_endpoint || '(disabled)');

// 健康检查（无需鉴权）
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', name: 'goofish-mcp', version: '1.0.0', authed: !!API_KEY, oauth: true });
});

// MCP 请求（静态 key 或 OAuth token 均可）
app.use('/mcp', async (req, res, next) => {
  if (!(await isAuthorized(req))) {
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: missing or invalid API key / token' },
      id: null,
    });
  }
  next();
});

app.post('/mcp', async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      transport.close();
      server.close();
    });
  } catch (e) {
    console.error('Error handling MCP request:', e);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

// stateless 模式下 GET/DELETE 不支持（无 SSE 流/无会话）
app.get('/mcp', (req, res) => res.status(405).json({
  jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null,
}));
app.delete('/mcp', (req, res) => res.status(405).json({
  jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null,
}));

app.listen(PORT, HOST, (err) => {
  if (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
  console.log(`goofish-mcp HTTP listening on http://${HOST}:${PORT}/mcp`);
});

process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
