# LinkShell Gateway 部署指南

## 方式 1：用 CLI 直接跑（最简单）

不需要 clone 仓库，不需要 Docker。

```bash
npm install -g linkshell-cli

# 后台运行（推荐）
linkshell gateway --daemon --port 8787

# 查看状态
linkshell gateway status

# 查看日志
tail -f ~/.linkshell/gateway.log

# 停止
linkshell gateway stop
```

## 方式 2：Docker 部署

### 从 Docker Hub 拉取（推荐）

```bash
docker pull nickname4th/linkshell-gateway:latest
docker run -d \
  -p 8787:8787 \
  --name linkshell-gateway \
  --restart unless-stopped \
  nickname4th/linkshell-gateway:latest
```

### 从源码构建

```bash
git clone https://github.com/LiuTianjie/LinkShell
cd LinkShell
docker compose up -d
```

Gateway 默认监听 `8787` 端口。

### 自定义端口

```bash
# 方式 1：环境变量
PORT=9000 docker compose up -d

# 方式 2：.env 文件
cp .env.example .env
# 编辑 .env 修改 PORT
docker compose up -d
```

### 查看日志

```bash
docker compose logs -f gateway
```

### 更新

```bash
# Docker Hub 方式
docker pull nickname4th/linkshell-gateway:latest
docker stop linkshell-gateway && docker rm linkshell-gateway
docker run -d -p 8787:8787 --name linkshell-gateway --restart unless-stopped nickname4th/linkshell-gateway:latest

# 源码方式
git pull
docker compose up -d --build
```

## 反向代理（HTTPS）

生产环境建议用 nginx 反代并启用 HTTPS。

### nginx 配置示例

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;

    ssl_certificate /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}

server {
    listen 80;
    server_name relay.example.com;
    return 301 https://$host$request_uri;
}
```

关键点：
- `proxy_http_version 1.1` + `Upgrade` + `Connection` 头是 WebSocket 必需的
- `proxy_read_timeout 86400s` 防止 nginx 断开长连接
- 用 Let's Encrypt 免费获取证书：`certbot --nginx -d relay.example.com`

### 使用 HTTPS 后的连接方式

```bash
# CLI
linkshell start --gateway wss://relay.example.com/ws --provider claude

# App 里输入
# https://relay.example.com
```

## 防火墙

只需开放 Gateway 端口（默认 8787）或 nginx 的 443 端口：

```bash
# UFW
ufw allow 8787/tcp

# 或者只开 HTTPS
ufw allow 443/tcp
```

## 健康检查

```bash
curl http://localhost:8787/healthz
# {"ok":true}
```

## 资源需求

Gateway 是纯消息转发，资源消耗很低：
- 内存：约 50MB 基础 + 每个活跃会话约 1MB
- CPU：几乎可忽略
- 带宽：取决于终端输出量，通常很小
- 最小配置：1 核 512MB 即可运行

## 官方 Gateway 部署（需订阅验证）

如果你要部署一个需要订阅验证的官方 Gateway（仅允许 Pro 用户连接），需要额外配置 Supabase 环境变量。

### Docker 方式

```bash
docker run -d \
  -p 8787:8787 \
  --name linkshell-gateway \
  --restart unless-stopped \
  -e AUTH_REQUIRED=true \
  -e SUPABASE_URL=https://your-project.supabase.co \
  -e SUPABASE_ANON_KEY=your-anon-key \
  -e SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
  nickname4th/linkshell-gateway:latest
```

### docker-compose 方式

```bash
cp .env.example .env
# 编辑 .env，设置：
# AUTH_REQUIRED=true
# SUPABASE_URL=https://your-project.supabase.co
# SUPABASE_ANON_KEY=your-anon-key
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

docker compose up -d
```

### 环境变量说明

| 变量 | 必需 | 说明 |
|------|------|------|
| `AUTH_REQUIRED` | 否 | 设为 `true` 启用订阅验证，默认 `false` |
| `SUPABASE_URL` | AUTH_REQUIRED=true 时必需 | Supabase 项目 URL |
| `SUPABASE_ANON_KEY` | AUTH_REQUIRED=true 时必需 | Supabase anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | AUTH_REQUIRED=true 时必需 | 用于服务端订阅到期检查 |

### 行为差异

- `AUTH_REQUIRED=false`（默认）：任何人都可以连接，适合自建 Gateway
- `AUTH_REQUIRED=true`：
  - 所有 HTTP 和 WebSocket 连接需要有效的 Supabase JWT
  - 验证用户是否有活跃的 Pro 订阅
  - 非订阅用户收到 `subscription_required` 错误，提示去 itool.tech 订阅
  - 每 5 分钟检查已连接用户的订阅状态，到期自动断开
