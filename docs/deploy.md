# 自建 LinkShell 网关

网关让手机在任何网络下都能连到你的电脑。它只做两件事：转发手机和电脑之间**端到端加密**的数据，以及在配对时让两边碰头。网关看不到你的代码和对话，也不需要多少资源。

> 不想自己部署？Pro 订阅提供官方网关：电脑上 `linkshell login`，App 里登录同一账号即可。

## 1. 运行网关

### 用 CLI（最简单）

```bash
npm i -g linkshell-cli          # 需要 Node.js 22.13+
linkshell gateway --port 8787 --daemon

linkshell gateway status
tail -f ~/.linkshell/gateway.log
linkshell gateway stop
```

配对关系保存在 `~/.linkshell/relay.db`，重启网关后依然有效。

### 用 Docker

```bash
docker run -d --name linkshell-gateway --restart unless-stopped \
  -p 8787:8787 -v linkshell-gateway:/data \
  nickname4th/linkshell-gateway:latest
```

- 配对关系保存在 `/data/relay.db`，请挂载卷（上面的 `-v`），否则重建容器后需要重新配对。
- 镜像目前是 `linux/amd64`。在 arm64 主机上加 `--platform linux/amd64`。
- 更新：`docker pull nickname4th/linkshell-gateway:latest`，然后删掉旧容器、用同样的命令重新运行。

从源码构建：`git clone https://github.com/LiuTianjie/LinkShell && cd LinkShell && docker compose up -d`。

## 2. 加上 HTTPS

在公网上请用 HTTPS 反向代理，让电脑和手机通过 `wss://` 连接。

### Caddy（自动申请证书）

```caddyfile
gw.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

### Nginx

```nginx
server {
    listen 443 ssl;
    server_name gw.example.com;

    ssl_certificate     /etc/letsencrypt/live/gw.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/gw.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

`Upgrade` / `Connection` 头是 WebSocket 必需的；较长的 `proxy_read_timeout` 防止空闲连接被断开。证书可以用 `certbot --nginx -d gw.example.com` 免费申请。

## 3. 连接电脑和手机

在电脑上：

```bash
linkshell host --gateway wss://gw.example.com --daemon   # 地址会被记住
linkshell pair
```

终端里会出现二维码和 6 位配对码。在 App 的「电脑 → 添加电脑」里扫码或输入配对码。配对一次长期有效，电脑重启不需要重新配对。

- 换网关：`linkshell host stop && linkshell host --gateway wss://另一个地址 --daemon`，然后重新配对。
- 关闭网关连接：`linkshell host --gateway off`。

### 只在家里用

网关可以直接跑在这台电脑上，不需要服务器和证书：

```bash
linkshell gateway --daemon
linkshell host --gateway ws://192.168.1.20:8787 --daemon   # 换成电脑的局域网 IP
linkshell pair
```

手机需要和电脑在同一个局域网里。

## 防火墙与健康检查

只需要开放网关端口（8787），或反向代理的 443：

```bash
ufw allow 443/tcp     # 使用 HTTPS 反代时
ufw allow 8787/tcp    # 直接暴露网关时
```

```bash
curl http://localhost:8787/healthz
# {"ok":true, …}
```

## 资源

网关只转发数据：内存几十 MB，CPU 几乎可以忽略，带宽取决于你在手机上看了多少输出。一台最小规格的云服务器就够用。

## 1.x

同一个网关也继续服务 1.x 的 `linkshell start` 和 1.x App，不需要单独部署。
