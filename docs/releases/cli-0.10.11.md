# CLI 0.10.11

## 改动

- 从 Claude 会话中启动 LinkShell 时，清理继承的 `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST` 和 `CLAUDE_CODE_HOST_AUTH_ENV_VAR`，避免独立 Claude 错用父宿主的认证方式、在手机上误报未登录。
- 保留用户的认证 Token、API 地址、模型和配置目录，包括 CC Switch 写入的配置。

## 发布组件

| 制品 | 版本 | 原因 |
| --- | --- | --- |
| @linkshell/host | 0.4.11 | 修正 Claude 子进程环境清理 |
| linkshell-cli | 0.10.11 | 使用 host 0.4.11，并包含修正后的 Host 源码构建 |

App、wire、gateway 和 mac 无改动，不发布；官方网关不重新部署。

## 验证

- `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm test` 全部通过。
- 新增回归测试：清理父宿主认证变量，同时保留用户提供方配置，不修改原始环境对象。
- 真实 Claude 2.1.295：使用当前后台继承的同一份环境，旧清理逻辑返回 `loggedIn: false`，新清理逻辑返回 `loggedIn: true`、`authMethod: oauth_token`。此项验证为认证状态检查，未发送模型请求。

升级后需重启 Host，让新版本的环境清理逻辑生效。
