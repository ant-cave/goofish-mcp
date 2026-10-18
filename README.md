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

## 鉴权

- 静态 key：`Authorization: Bearer <GOOFISH_API_KEY>` 或 `x-api-key`
- OAuth：本服务自签发（PKCE 授权码，自动批准），Bearer access token 同样可用
- 健康检查 `/health` 无需鉴权

## 依赖

- Node.js ≥ 20
- 本地 `goofish-client`（提供登录态与 mtop client）
- `@modelcontextprotocol/sdk`、`zod`

## License

MIT
