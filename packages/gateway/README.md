# @linkshell/gateway

LinkShell 网关：手机和电脑之间的中继。它用密钥认证两端，在允许互相访问的手机和电脑之间转发**端到端加密**的数据帧（网关读不了内容），并负责配对（二维码或 6 位配对码）。

官方网关（`gateway.itool.tech`）和自建网关运行的是同一份代码。区别只在配置：自建网关没有账号，靠配对；官方网关另外校验账号和 Pro 订阅。

需要 Node.js 22.13 或更新版本（数据用 Node 自带的 SQLite 保存）。完整的自建步骤（HTTPS、反向代理、连接手机）见[部署指南](https://github.com/LiuTianjie/LinkShell/blob/main/docs/deploy.md)。

## 运行

### 用 CLI

```bash
npm i -g linkshell-cli
linkshell gateway --port 8787 --daemon
linkshell gateway status
linkshell gateway stop
```

数据保存在 `~/.linkshell/relay.db`，日志在 `~/.linkshell/gateway.log`。

### 用 Docker

```bash
docker run -d --name linkshell-gateway --restart unless-stopped \
  -p 8787:8787 -v linkshell-gateway:/data \
  nickname4th/linkshell-gateway:latest
```

数据在容器里的 `/data/relay.db`，所以要挂载卷。镜像目前只有 `linux/amd64`。

从源码构建镜像：在仓库根目录运行 `docker compose up -d`。

### 从源码

```bash
pnpm install
pnpm --filter @linkshell/wire build
pnpm --filter @linkshell/gateway build
PORT=8787 RELAY_DATA_PATH=./data/relay.db node packages/gateway/dist/gateway/src/main.js

pnpm dev:gateway     # 开发：tsx 直接运行 src/main.ts
```

### 作为库

```ts
import { startGateway } from "@linkshell/gateway";

const gateway = await startGateway({ port: 8787, databasePath: "./relay.db" });
// gateway.port；结束时 await gateway.close()
```

`linkshell gateway` 就是这样启动它的。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8787` | 监听端口 |
| `LOG_LEVEL` | `info` | 日志级别：debug / info / warn / error |
| `RELAY_DATA_PATH` | `./data/relay.db` | 数据文件（SQLite）。Docker 镜像里是 `/data/relay.db` |
| `TRUSTED_PROXIES` | 空 | 反向代理的 IP（网关看到的来源地址），逗号分隔；IPv4 可以写成网段，如 `172.16.0.0/12`。只有连接来自这些地址时才采信 `X-Forwarded-For`；留空则一律按直接连接的地址计算限流 |
| `WS_CONNECT_RATE_LIMIT_MAX` | `20` | 每个 IP 在一个时间窗口内允许的连接次数（本机回环地址不限） |
| `WS_CONNECT_RATE_LIMIT_WINDOW_MS` | `60000` | 上面的时间窗口 |
| `SUPABASE_URL`、`SUPABASE_ANON_KEY` | - | 两个都设置后启用账号：校验账号令牌，同一账号下的手机和电脑不用配对就能互相访问 |
| `AUTH_REQUIRED` | `false` | 设为 `true`：电脑必须登录账号并且订阅有效才能接入（手机不受影响） |
| `SUPABASE_SERVICE_ROLE_KEY` | - | `AUTH_REQUIRED=true` 时用它查询订阅 |

自建网关一般只需要 `PORT` 和 `RELAY_DATA_PATH`。网关前面有反向代理时要留意连接限流按谁的地址算：

- 没有设置 `TRUSTED_PROXIES`：所有连接都算作来自代理的地址。代理在另一台机器或另一个容器里时，所有用户共用一份限额（每分钟 20 次连接）；代理在本机（`127.0.0.1`）时则完全不限流。
- 设置为代理的地址（代理在本机时是 `127.0.0.1,::1`）：按 `X-Forwarded-For` 里每个用户自己的地址分别限流。
- 代理在容器网络里、地址每次部署都会变：写成它所在的网段（如 `172.16.0.0/12`）。
- 前面有多层代理（CDN 再到 nginx）：每一层都要列出来。用户的地址取的是 `X-Forwarded-For` 里**从右往左第一个不属于代理的地址**：最左边那一段是调用方自己写的，不能信。
- 不确定代理的地址是什么：先不设置，看网关日志。收到带 `X-Forwarded-For` 却不在名单里的连接时，日志会写出它的地址（每个地址只说一次）。

### 带账号和订阅校验的部署

官方网关是这样配置的（见仓库根目录的 `luma-gateway.yml`）：

```bash
AUTH_REQUIRED=true
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

- 账号令牌通过 `${SUPABASE_URL}/auth/v1/user` 校验。
- 订阅查的是 `profiles` 表：`plan` 为 `pro` 且 `plan_expires_at` 晚于当前时间才算有效。
- 只在电脑连接时检查一次；查询本身失败（网络、配置问题）时放行，不会因为一次查询失败把用户挡在外面。

## 接口

| | 路径 | 说明 |
|------|------|------|
| `WS` | `/v2/connect` | 电脑（host）和手机 App 的连接 |
| `GET` | `/healthz` | 健康检查 |

`/` 提供新版网页客户端，`/assets/*` 提供静态资源，`/config.js` 返回公开部署配置。未配置 Supabase 时自动使用当前网关配对；官方配置启用账号入口。`WEB_PREVIEW_ORIGIN` 可指定独立端口预览来源。其他路径返回 404。

```bash
curl http://localhost:8787/healthz
# {"ok":true,"version":"0.6.0","relay":2,"memoryMb":61}
```

`relay` 是当前在线的连接数（电脑加手机），`memoryMb` 是进程占用的内存。

## 数据文件

全部数据就是一个 SQLite 文件：每台电脑、每台手机的公钥、名称和所属账号，以及哪台手机和哪台电脑配对。没有任何会话内容。

**这个文件丢了，所有手机都要重新配对。** 迁移或升级时带上它（Docker 就是保留那个卷）；备份时连同旁边的 `-wal`、`-shm` 文件一起，或者先停掉网关。

## 从 0.5.x 升级

0.6.0 去掉了 1.x 的那一半，只保留中继：

- 1.x 的接口没有了：`/ws`、`/pairings*`、`/sessions*`、`/tunnel/*`，以及根路径上的网页控制台。1.x 的 App 和 `linkshell start` 不能再连接这个网关。
- 这些环境变量不再读取，可以删掉：`PAIRING_TTL_MS`、`PAIRING_RATE_LIMIT_*`、`CLAIM_FAILURE_RATE_LIMIT_*`、`SUPABASE_GATEWAY_TOKEN_TABLE`、`SUPABASE_GATEWAY_PAIRING_TABLE`、`SUPABASE_STATE_TIMEOUT_MS`、`WEB_DIST`。
- 数据文件和格式没有变：沿用原来的 `relay.db`（Docker 沿用原来的卷），已配对的手机不用重新配对。2.x 的 CLI 和 App 不需要任何改动。
- 作为库使用时：`@linkshell/gateway/embedded` 的 `startEmbeddedGateway` 换成 `startGateway`；`@linkshell/gateway-v2` 已并入本包，不再单独发布。

## 代码入口

1. `src/relay.ts`：`Gateway`，认证、路由、配对、背压
2. `src/store.ts`：SQLite 里的两张表（`peers`、`links`）
3. `src/serve.ts`：`startGateway`，HTTP 服务、`/healthz`、连接限流
4. `src/main.ts`：可执行入口，读环境变量后调用 `startGateway`
5. `src/accounts.ts`、`src/subscription.ts`：账号令牌和订阅

`/v2/connect` 这个路径和 `store.ts` 里的表结构不能改：已安装的每一台电脑和手机都依赖它们。

## License

MIT
