# @linkshell/gateway

LinkShell Gateway — WebSocket 消息中转服务，连接 CLI 和手机 App。

Gateway 不运行任何终端进程，只负责配对、会话管理和消息路由。

## 部署

### Docker（推荐）

```bash
docker compose up -d
```

### 直接运行

```bash
pnpm install
pnpm --filter @linkshell/gateway build
PORT=8787 node packages/gateway/dist/gateway/src/index.js
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8787` | 监听端口 |
| `LOG_LEVEL` | `info` | 日志级别：debug / info / warn / error |
| `AUTH_REQUIRED` | `false` | 设为 `true` 后要求 Supabase JWT 并校验订阅 |
| `SUPABASE_URL` | - | Supabase 项目 URL |
| `SUPABASE_ANON_KEY` | - | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | - | 服务端订阅检查和 Gateway 状态持久化使用 |
| `SUPABASE_GATEWAY_TOKEN_TABLE` | `linkshell_gateway_tokens` | 设备 token 持久化表 |
| `SUPABASE_GATEWAY_PAIRING_TABLE` | `linkshell_gateway_pairings` | 配对状态持久化表 |
| `PAIRING_TTL_MS` | `600000` | 配对码有效期，默认 10 分钟 |

启用官方服务版部署时，先在 Supabase 执行 `docs/supabase-gateway-state.sql`。表不存在时 Gateway 会退回内存态，但 Docker 重启后设备 token 和未过期配对状态不会恢复。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/healthz` | 健康检查 |
| `POST` | `/pairings` | 创建配对（返回 6 位 code，默认 10 分钟有效） |
| `POST` | `/pairings/claim` | 用 code 换取 sessionId |
| `GET` | `/pairings/:code/status` | 查询配对状态 |
| `GET` | `/sessions` | 列出活跃会话 |
| `GET` | `/sessions/:id` | 会话详情 |
| `WS` | `/ws?sessionId=&role=` | 实时连接（role=host 或 client） |

## 特性

- 内存态会话管理，可选 Supabase 持久化设备 token 和配对状态
- ACK 追踪 + 输出缓存（最近 200 条，client 重连时快速重放）
- 单设备控制权管理（claim/grant/reject/release）
- 心跳 ping/pong 检测死连接（20s 间隔）
- 会话 TTL（host 断开保留 60s，空闲 30min 清理）
- IP 限流（配对 30 req/min，WebSocket 20 conn/min）
- CORS 支持
- 协议版本协商
- 优雅关闭（SIGINT/SIGTERM）

## 代码入口

如果要继续改 Gateway，优先从这几个文件进入：

1. src/index.ts
2. src/pairings.ts
3. src/sessions.ts
4. src/relay.ts

## License

MIT
