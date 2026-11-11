# iTool 会员

LinkShell 的官方网关属于 iTool 会员。一份会员、两个档位，只在 itool.tech 用支付宝购买：

| 档位 | 价格 | 包含 |
| --- | --- | --- |
| 月度 | ¥9.9 | iTool 网站 + LinkShell |
| 年度 | ¥99 | 全部 iTool 产品 |

LinkShell 的产品键是 `linkshell`，所需档位 `monthly`，所以月度、年度会员都有 LinkShell。激活码已停用：没有兑换入口，也不再销售激活码（已售出的激活码持有人已在数据库中转为年度会员）。

购买页：`https://www.itool.tech/zh/pro?from=linkshell`（英文 `/en/pro`）。直接写 www 和语言：裸域名要多跳两次（308 到 www，再 307 到语言）。加 `&checkout=yearly` 时，登录后直接打开年度付款，月度会员的「升级年度」用的就是它。登录和付款都在那里完成。

## 读取会员

- 用用户自己的令牌：`GET https://itool.tech/api/membership/entitlement?product=linkshell`，`Authorization: Bearer <access token>`，CORS `*`，不带 Cookie。200 返回 RPC 结果；401 `login_required` 表示需要刷新令牌或重新登录；502/503 `temporarily_unavailable` 表示稍后再试，保留上一次的状态。供 supabase.co 被屏蔽的网络使用。
- 或直接调 Supabase RPC `public.itool_entitlement(p_product text)`，结果相同：`{ ok, product, required_tier, active, valid_until, tier, member_until, yearly_until, server_time }`，失败时 `{ ok:false, code:'login_required'|'unknown_product' }`。
- 官方网关用 service-role key 调 `public.itool_entitlement_for(p_user uuid, p_product text)`，只看 `active`。查询本身失败（网络、配置、非 2xx、`ok:false`）时放行，和以前一样不因一次查询失败挡住电脑。

客户端只信 `active`：`valid_until` 早于服务端时间时仍按普通账户显示。档位 `tier` 用来显示「iTool 月度会员 / 年度会员」。

## 各端

- `packages/client-core/src/pro-membership.ts`：`fetchProMembership` 默认先走 itool.tech，不可达或 502/503 时再试 RPC（`prefer: "supabase"` 反过来）；令牌被拒或已经拿到答案时不再换路。`membershipFromEntitlement` 是映射规则，`ITOOL_MEMBERSHIP_URL` 是购买页。
- CLI / 桌面（`packages/cli/src/pro-membership.ts`）：`linkshell login` 和 `desktop --action account-refresh` 读取会员，写入按账号隔离的显示缓存 `~/.linkshell/account-pro.json`（含 `tier`）。网络不可达时保留上次状态。`LINKSHELL_TOKEN_PROXY=off` 时先走 Supabase。缓存不是网关授权依据。
- Mac / Windows 桌面、网页工作区：普通账户显示「开通 iTool 会员」按钮，在系统浏览器打开购买页；回到窗口时自动刷新会员状态，也可以手动刷新。
- 手机 App 和 Apple Watch：不提供购买（App Store 规则），没有链接、价格或按钮，只显示一行「在电脑浏览器打开 itool.tech/pro 开通会员」，回到前台时刷新。
