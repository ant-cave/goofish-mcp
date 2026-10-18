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
GOOFISH_API_KEY=<admin-key> \
GOOFISH_DATA_DIR=/home/ant/service/goofish-mcp/data \
node server.js
```

默认监听 `127.0.0.1:8670`。建议前置 nginx 反代到公网域名（需配置 `GOOFISH_ISSUER` 与 HTTPS）。

| 环境变量 | 说明 |
| --- | --- |
| `GOOFISH_API_KEY` | 初始管理密钥（仅首次；之后在面板内修改，存 `DATA_DIR/api-key.txt`） |
| `GOOFISH_DATA_DIR` | 数据目录：密钥文件、API Keys、日志（默认 `/home/ant/service/goofish-mcp/data`） |
| `GOOFISH_CLIENT_DIST` | goofish-client 入口（缺省用内置 mock，便于本地演示） |
| `GOOFISH_DEMO` | 演示模式：mock 数据 + 面板出现「模拟扫码确认」按钮 |
| `GOOFISH_ISSUER` | OAuth issuer（默认取请求 host） |
| `GOOFISH_PORT` | 监听端口（默认 8670） |

## 客户端接入

MCP endpoint（streamable-http）：

```
https://<your-domain>/mcp
```

鉴权三级，任一通过即可：

1. **管理密钥** — `Authorization: Bearer <管理密钥>`（面板登录同一把钥匙，权限最大）
2. **客户端 API Key** — 在「API Keys」面板创建的多把 key，可单独命名/禁用/删除，禁用后调用即 401
3. **OAuth token** — 标准 MCP OAuth 流程（PKCE）；`/authorize` 要求鉴权：携带 `?key=<key>`，或使用已登录 `/admin` 的会话

OpenClaw / Claude / ChatGPT 等客户端的 MCP 配置示例：

```json
{
  "mcpServers": {
    "goofish": {
      "url": "https://<your-domain>/mcp",
      "transport": "streamable-http",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

## 管理界面

`https://<your-domain>/admin` — 登录密钥即管理密钥（首次为 `GOOFISH_API_KEY`）。

- **概览** — 闲鱼扫码登录/登录态管理、MCP endpoint 与客户端配置示例（一键复制）、OAuth token 吊销
- **调用日志** — 全量审计（MCP 请求与管理操作），按类型/结果/工具筛选、关键词搜索、分页、CSV 导出、自动刷新
- **API Keys** — 客户端 key 的创建/复制/禁用/删除，显示最近使用时间
- **设置** — 修改管理密钥（热更新，改后旧会话与旧密钥立即全部失效）

## 项目结构

```
server.js          # 薄入口：组装模块、三级鉴权、/mcp 路由
routes/admin.js    # /admin 全部路由（页面 + JSON API + OAuth 守卫）
lib/config.js      # 管理密钥热配置（DATA_DIR/api-key.txt, chmod 600）
lib/apikeys.js     # 客户端多 Key 管理（DATA_DIR/api-keys.json）
lib/logger.js      # JSONL 调用日志（按日切分、保留 7 天、统计聚合）
lib/ratelimit.js   # IP 防爆破（失败计数 + 内存锁定）
lib/session.js     # HMAC 无状态会话（管理密钥 + 日期签名）
public/            # 零构建前端：admin.html / login.html / app.css / js/
```

## 安全

- 防爆破：`/mcp` 与 `/admin` 鉴权失败按 IP 计数，超限临时锁定（默认 10 次/10min 锁 15min）
- OAuth `/authorize` 必须携带凭证，无匿名授权
- 数据文件（密钥、API Keys）均 `chmod 600`，位于 `GOOFISH_DATA_DIR`
- `/health` 无需鉴权（仅状态信息）

## 依赖

- Node.js ≥ 20
- 本地 `goofish-client`（提供登录态与 mtop client）
- `@modelcontextprotocol/sdk`、`zod`

## License

MIT
