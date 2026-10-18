# goofish-mcp

闲鱼（Goofish）MCP 服务器：基于本机 goofish-client 登录态，通过 mtop 接口提供商品搜索、详情、关键词监控快照与发布能力，输出为 MCP tools（streamable-http）。

## 工具

- `search_items` — 关键词搜索（返回 item_id/标题/价格/卖家/地区/发布时间）
- `get_item_detail` — 商品详情（标题/价格/描述/浏览收藏/卖家/图片 URL 列表）
- `monitor_keyword` — 关键词监控快照（带去重 key）
- `publish_item` — 发布闲置商品（支持本地图床上传）

## 运行

```bash
GOOFISH_CLIENT_DIST=/home/ant/dev/goofish-client/dist/index.js \
GOOFISH_API_KEY=<your-key> \
node server.js
```

默认监听 `127.0.0.1:8670`。建议前置 nginx 反代到公网域名（需配置 `GOOFISH_ISSUER` 与 HTTPS）。

## 客户端接入

MCP endpoint（streamable-http）：

```
https://<your-domain>/mcp
```

鉴权二选一：

1. 静态 key（最简单）：请求头带 `Authorization: Bearer <GOOFISH_API_KEY>` 或 `x-api-key: <key>`
2. OAuth：标准 MCP OAuth 流程（PKCE）。`/authorize` 现已要求鉴权——发起授权时携带 `?key=<GOOFISH_API_KEY>`，或使用已登录 `/admin` 的会话

OpenClaw / Claude / ChatGPT 等客户端的 MCP 配置示例：

```json
{
  "mcpServers": {
    "goofish": {
      "url": "https://<your-domain>/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer <GOOFISH_API_KEY>" }
    }
  }
}
```

## 管理界面

`https://<your-domain>/admin` — 闲鱼扫码登录、登录态管理、OAuth token 查看/吊销。登录密钥即 `GOOFISH_API_KEY`。

## 安全

- 防爆破：`/mcp` 与 `/admin` 鉴权失败按 IP 计数，超限临时锁定（默认 10 次/10min 锁 15min）
- OAuth `/authorize` 必须携带凭证，无匿名授权
- `/health` 无需鉴权（仅状态信息）

## 依赖

- Node.js ≥ 20
- 本地 `goofish-client`（提供登录态与 mtop client）
- `@modelcontextprotocol/sdk`、`zod`

## License

MIT
