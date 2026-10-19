# Pro 激活码兑换

LinkShell 使用 iTool 的同一账户和 Pro 权益。手机 App 的“账号与电脑”、Mac 总览/设置、Web 账户设置、独立 Apple Watch 的“连接设置 → 会员与激活码”提供兑换入口。已登录普通账户显示激活码输入框与“没有激活码？前往链动小铺”链接；已有 Pro 显示到期时间。会员状态尚未读取或读取失败时，不将账户当成普通账户。

链动小铺沿用现有月付商品地址：`https://pay.ldxp.cn/item/7lgv1s`。

## 接口与状态

- 会员读取：使用当前账户令牌读取 Supabase `profiles.plan` 和 `plan_expires_at`，有效 Pro 需要 `plan = pro` 且尚未到期。
- 兑换：`POST https://itool.tech/api/pro/redeem`，`Authorization: Bearer <access_token>`，JSON `{ "code": "..." }`。不携带浏览器 Cookie，不把服务角色密钥放进客户端。
- iTool 验证账户后调用现有兑换 RPC，校验和消费激活码并写入权益。LinkShell 客户端不自行修改会员数据库。
- 成功响应需要可信接口的 `ok`、`valid`、有效期和服务端时间。同账号重试已用码不会重复增加时长；已兑换且权益过期的旧码提示使用新的激活码。
- 提交绑定表单所属账户，令牌刷新前后检查身份，账户切换时不将激活码兑换到新账户，也不覆盖新账户显示。
- 兑换请求期间阻止重复提交。已确认兑换后，会员或网关刷新失败保留成功回执，不提示激活失败。

手机和 Web 使用 `packages/client-core/src/pro-membership.ts`。Mac 通过内置 CLI 的 `desktop --action redeem-pro`，从标准输入读取 `{code,userId}`；`account-refresh` 主动刷新，桌面快照轮询仅读 `~/.linkshell/account-pro.json` 中按账号隔离的显示缓存。缓存不是网关授权依据。

## 发布依赖与验证边界

需先部署 iTool 仓库的 `/api/pro/redeem` Bearer 鉴权与无凭据 CORS 支持，再发布 LinkShell 各客户端。独立 Mac App 必须捆绑本轮 CLI；不能仅更新界面而沿用旧内置 CLI。Web 随网关构建交付。

本轮没有部署后端、发布客户端或消费真实激活码。验证覆盖共享接口契约、账户切换竞态、错误与幂等处理、客户端类型检查、Web 构建和模拟接口浏览器检查，以及 Mac Swift 测试和示例账户界面渲染。模拟响应不代表真实付款兑换、生产 OAuth 或手机真机验收。
