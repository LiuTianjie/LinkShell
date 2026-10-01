# LinkShell 发版 SOP

## 版本号规范

- CLI: `linkshell-cli@x.y.z`
- Gateway: `@linkshell/gateway@x.y.z`
- Protocol: `@linkshell/protocol@x.y.z`
- Docker tag: `gateway-vx.y.z`

Protocol → Gateway → CLI 是依赖链。只改 CLI 时可以只发布 CLI；改 shared protocol 或 gateway relay/tunnel/agent envelope 时，按依赖链依次发。

## 1. 发版前检查

```bash
# 确保代码干净
git status

# 类型检查
pnpm typecheck

# 本地测试
pnpm dev:cli start --provider custom --command bash

# Agent Workspace smoke test（如果本机安装了 Claude Code 或 Codex）
pnpm --filter linkshell-cli dev start --agent-ui --provider custom --command bash
```

## 2. 更新版本号

```bash
# 更新 packages/shared-protocol/package.json 的 version（如果协议有改动）
# 更新 packages/gateway/package.json 的 version（如果 gateway 或 protocol 依赖有改动）
# 更新 packages/cli/package.json 的 version
# 同步更新根 package.json version，保持仓库级版本可追踪
```

## 3. 构建

```bash
pnpm build
```

## 4. 发布 npm 包

> ⚠️ **必须使用 `pnpm publish`，绝不能用 `npm publish`**。
> 这个仓库 workspace 里的内部依赖写的是 `workspace:*`（见 `packages/cli/package.json`、`packages/gateway/package.json`）。
> `pnpm publish` 在打 tarball 时会把 `workspace:*` 重写成具体版本号；`npm publish` 不会，发出去的包到了用户机器上 `npm install` 会直接报 `EUNSUPPORTEDPROTOCOL "workspace:"`，整个 `linkshell upgrade` 链路就坏了。这种情况发生过一次（v0.4.0），当场只能 deprecate + bump 0.4.1 抢救。

> 📦 **CLI 会把 web 控制台打进 tarball（自动）**。`packages/cli` 的 `prepack` 钩子在 `pnpm pack`/`pnpm publish` 时会先构建 `@linkshell/web-dashboard`（及其依赖 protocol），再跑 CLI 自身 build（`tsc` + `copy-web.mjs` 把 `web-dashboard/dist` 拷进 `packages/cli/web`）。所以**发 CLI 前不需要手动构建 web**，发出去的包里 `web/` 一定是新鲜的。内置/局域网/自托管网关靠这份 `web/` 同源伺服 web 控制台（云端 gateway 的 Docker 镜像则在 Dockerfile 里单独构建 web，是另一条线）。
> ⚠️ 别用 `npm publish`/`npm pack`——除了上面的 `workspace:` 问题，npm 不会触发 pnpm 的 `prepack` 工作区构建逻辑，`web/` 可能是旧的或空的。

```bash
# 发布 protocol（如果有改动）
cd packages/shared-protocol
pnpm publish --access public

# 发布 gateway（如果有改动）
cd ../gateway
pnpm publish --access public

# 发布 CLI
cd ../cli
pnpm publish --access public
```

> 🖥 **`@linkshell/host` 带着一个签名的 Mac 程序（`helper/LinkShell.app`）**。它持有看屏幕、控制电脑所需的两项系统权限（录屏、辅助功能），所以**必须在装有 `Developer ID Application` 证书的 Mac 上发布 host**。`packages/host` 的 `prepack` 钩子会以 `LINKSHELL_REQUIRE_HELPER=1` 重新构建：没有证书、没有 Swift 编译器或签名失败，发布直接中止，包发不出去。签名身份决定了权限记在谁名下，换证书等于让所有用户重新授权，不要换。
> 发布前可以先看一眼：`cd packages/host && pnpm pack`，解开后 `codesign --verify --strict package/helper/LinkShell.app` 应无输出。包里的主程序没有可执行权限是正常的（pnpm 打包会去掉），host 第一次用到时会自己补回来（`usableApp`），不影响签名。

### 4.1 发布后立即抽检 tarball

每发完一个包，下载下来检查 `dependencies`，确认没有任何 `workspace:` 字面量泄漏：

```bash
# 替换成刚发的版本号
VERSION=0.4.1

cd /tmp && rm -rf ls-publish-check && mkdir ls-publish-check && cd ls-publish-check
npm pack linkshell-cli@$VERSION
tar -xzf linkshell-cli-$VERSION.tgz
grep -n "workspace:" package/package.json && echo "❌ workspace: leaked, DO NOT release; deprecate this version" || echo "✅ deps look clean"

# CLI 还要确认 web 控制台真的进了包且不是空壳（prepack 应已构建好）
test -f package/web/index.html && ls package/web/assets/*.js >/dev/null 2>&1 \
  && echo "✅ web console bundled (web/index.html + assets present)" \
  || echo "❌ web/ missing or has no built assets — embedded-gateway console will be blank; rebuild & republish"

npm pack @linkshell/gateway@$VERSION
tar -xzf linkshell-gateway-$VERSION.tgz
grep -n "workspace:" package/package.json && echo "❌ workspace: leaked" || echo "✅ deps look clean"
```

发现 `workspace:` 就立刻：

```bash
npm deprecate linkshell-cli@$VERSION "broken: workspace:* deps not rewritten; use next patch"
npm deprecate @linkshell/gateway@$VERSION "broken: workspace:* deps not rewritten; use next patch"
npm deprecate @linkshell/protocol@$VERSION "use next patch"
```

然后 bump patch、改用 `pnpm publish` 重发。

## 5. 发布 Docker 镜像

Docker 镜像通过 GitHub Actions 自动构建发布。只需打 tag：

```bash
# 格式：gateway-vX.Y.Z
git tag gateway-v0.2.23
git push origin gateway-v0.2.23
```

CI 会自动：
- 构建 Docker 镜像
- 推送到 Docker Hub: `nickname4th/linkshell-gateway:latest` + `nickname4th/linkshell-gateway:0.2.23` + `nickname4th/linkshell-gateway:0.2`

### Docker Hub 首次配置

1. 在 [Docker Hub](https://hub.docker.com/) 创建 `nickname4th/linkshell-gateway` 仓库
2. 在 GitHub repo Settings → Secrets 添加：
   - `DOCKERHUB_USERNAME`: Docker Hub 用户名
   - `DOCKERHUB_TOKEN`: Docker Hub Access Token（在 Docker Hub → Account Settings → Security 创建）

## 6. 更新 Homebrew Formula

npm 发布后，运行脚本自动更新 tap：

```bash
# 自动检测版本、下载 tarball、算 sha256、更新 tap 仓库并推送
./scripts/update-brew.sh

# 或指定版本号
./scripts/update-brew.sh X.Y.Z
```

### Homebrew Tap 首次配置

1. 创建 GitHub 仓库 `LiuTianjie/homebrew-linkshell`
2. 将 `docs/brew/Formula/linkshell.rb` 复制到该仓库的 `Formula/linkshell.rb`
3. 用户安装：`brew install LiuTianjie/linkshell/linkshell`

## 7. 移动端发版（apps/client，2.0）

发布的 App 是 `com.bd.linkshell`（App Store / APK 上的 LinkShell）。开发版用 `APP_VARIANT=development`（`pnpm --filter @linkshell/client ios|android` 已带上），装成 `com.bd.linkshell.v2`，与正式版并存。见 `apps/client/app.config.js`。

### 推荐：打 tag 走 CI

```bash
./scripts/release-mobile.sh 2.0.1
```

推送 `vX.Y.Z` 触发两个 self-hosted macOS workflow，都调用 `apps/client/scripts/release.mjs`：
- `.github/workflows/ios-build.yml` → prebuild、archive、上传 TestFlight
- `.github/workflows/android-build.yml` → AAB + APK，并创建 GitHub Release `LinkShell X.Y.Z`

版本号来自 tag：`version = X.Y.Z`，`buildNumber / versionCode = MAJOR*10000 + MINOR*100 + PATCH`。

### 本地构建（runner 离线时）

```bash
cd apps/client
node scripts/release.mjs ios          # 用 app.json 里的版本；或 node scripts/release.mjs ios 2.0.1
node scripts/release.mjs android      # 输出 build/release/LinkShell-X.Y.Z.apk / .aab
gh release create vX.Y.Z build/release/LinkShell-X.Y.Z.apk build/release/LinkShell-X.Y.Z.aab --title "LinkShell X.Y.Z"
```

- Android release 用 Expo 模板的 `debug.keystore` 签名（与 1.x 相同），所以 APK 可以直接覆盖安装 1.x。
- iOS 需要本机 Xcode 登录了 team `L95PYLFT86`；上传后在 App Store Connect 处理完成才会出现在 TestFlight。
- 本地构建会重新生成 `ios/`、`android/`（正式版）；之后跑开发版需要 `APP_VARIANT=development npx expo prebuild --clean`。

## 8. 提交 & 打 Tag

```bash
git add -A
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z
git push origin main --tags
```

## 9. 创建 GitHub Release

```bash
gh release create vX.Y.Z \
  --title "vX.Y.Z" \
  --notes "## What's Changed
- feature 1
- feature 2
- bug fix 1"
```

Release notes 建议单独标出：
- Terminal provider 变化（claude/codex/gemini/copilot/custom）
- Agent Workspace capability/model/permission 变化
- Protocol 或 Gateway API 兼容性变化
- 移动端最低版本要求

如果有 Android APK，附加到 Release：

```bash
gh release upload vX.Y.Z ./apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

## 10. 发版后验证

```bash
# 验证 npm
npm info linkshell-cli version

# 验证 Docker
docker pull --platform linux/amd64 nickname4th/linkshell-gateway:latest
docker run --platform linux/amd64 --rm nickname4th/linkshell-gateway:latest node -e "console.log('ok')"

# 验证 Homebrew（首次 tap 后）
brew update
brew upgrade linkshell

# 验证 curl 安装
curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh

# 验证 upgrade 命令
linkshell upgrade

# 验证 provider detection
linkshell doctor
linkshell start --provider claude --no-agent-ui
linkshell start --provider codex --no-agent-ui

# 验证 Agent Workspace capabilities（至少覆盖 Codex 或 Claude 其一）
linkshell start --agent-ui --provider custom --command bash
```

## 快速发版 Checklist

- [ ] 代码通过 typecheck
- [ ] `pnpm test` 全部通过
- [ ] 版本号已更新（protocol、gateway、cli、根 package.json，按依赖链）
- [ ] `pnpm build` 成功
- [ ] **使用 `pnpm publish`（不是 `npm publish`）发布 npm 包**
- [ ] 抽检 tarball 里没有残留的 `workspace:` 字面量（见 §4.1）
- [ ] 抽检 CLI tarball 里 `web/index.html` + `web/assets/*.js` 存在（web 控制台已打包，见 §4.1）
- [ ] Docker tag 已推送（CI 自动构建）
- [ ] Homebrew formula 已更新 sha256
- [ ] GitHub Release 已创建
- [ ] 移动端已提交（如有改动）
- [ ] README、README_CN、docs/site、包级 README 已同步新功能
- [ ] Agent Workspace smoke test 已覆盖至少一个 provider（如有 Agent 改动）
