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

验证覆盖共享接口契约、账户切换竞态、错误与幂等处理、客户端类型检查、Web 构建和模拟接口浏览器检查，以及 Mac Swift 测试和示例账户界面渲染。完整工作区构建、类型检查、lint、测试及 Mac 输入/画面/应用检查通过；GitHub tests 和 real agents 检查通过。未消费真实激活码，模拟响应不代表真实付款兑换、生产 OAuth 或手机真机验收。

## 2026-10-19 发布记录

发布源码为 `f4f8afd0e1d795f0676785bdbab2ce71ed32e787`，包含功能提交 `499e982328eb9794c49d2d48b7051aa18ed2da72` 与公开使用说明。

- iTool 后端提交 `941c01ee3cb006a964dda0aee96ccaf3742efe60` 已部署，Luma v34 稳定运行。镜像 digest 为 `sha256:9d26b439015cd0b7b7a1b39e385a67a3ea777bcafb4e21156d77a0c762a6d691`；生产预检请求返回 204，未登录和无效 Bearer 请求返回 401。本地 iTool 仓库未配置 Git 远程，提交尚未推送。
- [手机与 Watch 2.3.37（20337）](https://github.com/LiuTianjie/LinkShell/releases/tag/v2.3.37)：iOS/Watch 四个 bundle 的版本与签名核验通过，App Store Connect 上传成功，尚未确认 TestFlight 处理完成。Android APK/AAB 已正式发布并设为 latest；实际下载的大小与 SHA-256 均与构建产物一致。上传中的第三方预编译框架缺 dSYM 警告未阻止上传成功。
- Gateway 0.6.23 已通过 [Docker CI](https://github.com/LiuTianjie/LinkShell/actions/runs/39255086839) 发布并部署到官方网关，Luma v43 stable，镜像 digest 为 `sha256:224a8e0d92cf5b64ea818866100a4a7b53ffbbbf98f8db8fc46f93ad6668fedd`。线上 Web 资源与隔离容器逐项 hash 一致，原本在线的本机 Host 自动重连。数据卷、数据库路径与认证配置保持原值；未执行已配对手机的交互验收。
- npm 已发布 `@linkshell/mac@0.1.13`、`@linkshell/host@0.4.44`、`@linkshell/gateway@0.6.23` 和 `linkshell-cli@0.10.46`；正式 tarball 的依赖版本、完整性及必需文件核验通过。空缓存临时安装成功，独立测试 Host/Gateway 的 Doctor 检查全部通过。Wire 0.2.16 未变更；`cli-v0.10.46` 标签和 [Homebrew 更新](https://github.com/LiuTianjie/homebrew-linkshell/commit/30b57900c19739f0595478b801bff0c914e04440)均已推送。
- [独立 Mac 0.10.46](https://github.com/LiuTianjie/LinkShell/releases/tag/desktop-v0.10.46)：arm64/x64 App 与 DMG 均通过 Apple 公证、签名及 staple 核验，内置运行环境检查通过；下载后的 DMG 长度和 SHA-256 与本地产物一致，Sparkle feed 的 Ed25519 签名使用配置中的公钥验证通过。x64 的 Rosetta 检查不代表 Intel 真机画面验收。桌面 Release 未占用移动端的 latest 标记。

| 产物 | SHA-256 |
| --- | --- |
| Android APK | `1445d0778a3ba5e1550735c23d219ffc32d7402af1fb844d6da426f5666e00a9` |
| Android AAB | `d0b31eecbebb7689b03dd12c85a9025f3de0f50e0ba7f632631e067b1c9b684c` |
| Mac arm64 DMG | `9cb3a10822292144333059ab677b435c6b564ef4ed45c75f6a3ef7db9de5ec79` |
| Mac x64 DMG | `2efde66cff619f37cb0109f4f738d7422ffdcd47471dab0c57201acf045e8549` |
