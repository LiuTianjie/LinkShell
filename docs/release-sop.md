# LinkShell 发版 SOP

## 包、版本号和 tag

| 发布物 | 目录 | 版本号 | 依赖 |
|---|---|---|---|
| `@linkshell/wire` | `packages/wire` | `package.json` | — |
| `@linkshell/mac`（LinkShell.app） | `apps/mac` | `package.json` | — |
| `@linkshell/host` | `packages/host` | `package.json` | wire；mac（可选依赖，仅 macOS arm64） |
| `@linkshell/gateway` | `packages/gateway` | `package.json` | wire |
| `linkshell-cli` | `packages/cli` | `package.json` | wire、host、gateway |
| Docker 镜像 `nickname4th/linkshell-gateway` | `packages/gateway/Dockerfile` | tag `gateway-vX.Y.Z` | — |
| App（iOS / Android） | `apps/client` | tag `vX.Y.Z` | — |

发布顺序就是依赖顺序：**wire → mac → host → gateway → cli**。没改的包跳过，但要注意：`workspace:*` 在发布时会被写成当时的**确切版本号**，所以上游发了新版本，下游也要跟着发一版才会用上它（改了 wire，就要发 host、gateway、cli；改了 `apps/mac`，就要发 mac、host、cli）。

`@linkshell/client-core` 和 `apps/client` 是私有包，不发 npm。`@linkshell/protocol`、`@linkshell/gateway-v2` 是已经删除的 1.x / 过渡包，不再发布。

三种 tag，各管各的：

- `cli-vX.Y.Z`：标记一次 CLI 发版，不触发 CI。
- `gateway-vX.Y.Z`：触发 CI 构建并推送 Docker 镜像。
- `vX.Y.Z`：触发 App 的 iOS、Android 构建。**只给 App 用**，不要拿它标记 CLI 版本。

## 1. 发版前检查

```bash
git status                # 干净
pnpm install
pnpm build                # 全量：CLI 会一并编译 host 和 gateway 的源码，单包检查发现不了的问题在这里暴露
pnpm typecheck
pnpm test                 # Mac 上包含 apps/mac 的 swift test
```

再按改动范围做真实验证：

```bash
# CLI / host：从源码跑一遍
cd packages/cli && npx tsx src/index.ts doctor

# host 的 Agent 驱动有改动（需要本机装好并登录对应的 Agent；live:claude 要在自己的终端里跑）
pnpm --filter @linkshell/host live:codex
pnpm --filter @linkshell/host live:claude

# apps/mac 有改动
pnpm --filter @linkshell/mac check

# gateway 有改动：本地构建镜像，跑起来
docker build -f packages/gateway/Dockerfile -t linkshell-gateway:dev .
docker run -d --name gw-dev -p 18787:8787 -v gw-dev:/data linkshell-gateway:dev
curl -s http://127.0.0.1:18787/healthz
```

然后用一个临时的 host 连上去（`LINKSHELL_HOME` 指向临时目录，不碰 `~/.linkshell`，也不带账号）：

```bash
# 终端 A：前台运行 host
export LINKSHELL_HOME=$(mktemp -d); echo $LINKSHELL_HOME
cd packages/cli && npx tsx src/index.ts host --gateway ws://127.0.0.1:18787

# 终端 B：同一个 LINKSHELL_HOME
export LINKSHELL_HOME=<终端 A 打印的目录>
cd packages/cli && npx tsx src/index.ts pair        # 应该出现二维码和 6 位配对码

# 结束后
docker rm -f gw-dev && docker volume rm gw-dev
```

> ⚠️ **网关的数据兼容性**。`packages/gateway/src/store.ts` 的表结构一旦有改动，必须验证旧数据还能读：用线上正在跑的那个镜像版本在一个新卷上启动、配对一次，再换成新镜像挂**同一个卷**，确认配对还在：直接用 sqlite 查 `links` 表，或者让配对过的那台手机不重新配对就连上。只看 `linkshell devices` 的列表不算数：那份列表来自 host 本地的 `paired-devices.json`，网关的数据丢了它也照样列出来。`/v2/connect` 这个路径和握手里的挑战串 `linkshell-gateway-v2:${nonce}` 不能改：所有已安装的电脑和手机都依赖它们。

## 2. 更新版本号

```bash
# 按依赖顺序改各自的 package.json：
#   packages/wire → apps/mac → packages/host → packages/gateway → packages/cli
# 根 package.json 的 version 跟 CLI 保持一致，方便在仓库层面追踪
```

App 的版本号来自 tag（见 §8），不用手改。

## 3. 构建

```bash
pnpm build
```

每个包的 `build` 都会先删掉 `dist/` 再编译，`prepack` 会在 `pnpm publish` 时自动再构建一次，所以发出去的包里不会带上已删除源码留下的旧文件。

## 4. 发布 npm 包

> ⚠️ **必须使用 `pnpm publish`，绝不能用 `npm publish`**。
> 这个仓库 workspace 里的内部依赖写的是 `workspace:*`（见 `packages/cli/package.json`、`packages/host/package.json`、`packages/gateway/package.json`）。
> `pnpm publish` 在打 tarball 时会把 `workspace:*` 重写成具体版本号；`npm publish` 不会，发出去的包到了用户机器上 `npm install` 会直接报 `EUNSUPPORTEDPROTOCOL "workspace:"`，整个 `linkshell upgrade` 链路就坏了。这种情况发生过一次（v0.4.0），当场只能 deprecate + bump 0.4.1 抢救。

```bash
cd packages/wire    && pnpm publish --access public   # 如有改动
cd ../../apps/mac   && pnpm publish --access public   # 如有改动（见下）
cd ../../packages/host    && pnpm publish --access public
cd ../gateway             && pnpm publish --access public   # 如有改动
cd ../cli                 && pnpm publish --access public
```

> ⏱ **npm 要过几分钟才看得到新版本**。刚发完就 `npm view`、`npm i -g linkshell-cli@latest` 或跑 `update-brew.sh`，可能拿到旧版本甚至 404。等几分钟；安装验证时写明版本号并加 `--prefer-online`：`npm i -g linkshell-cli@X.Y.Z --prefer-online`。

> 🖥 **LinkShell.app 在 `@linkshell/mac` 这个包里（源码在 `apps/mac`）**。它是 Mac 上的画面引擎：采集屏幕、编码、WebRTC 发送、注入鼠标键盘，并持有两项系统权限（录屏、辅助功能）。`@linkshell/host` 把它列为可选依赖（`os: darwin`），所以**改了 `apps/mac` 就要先发 `@linkshell/mac`，再发 host、cli**：
> ```bash
> cd apps/mac && pnpm publish --access public   # prepack 会重新构建、签名、打成 build/LinkShell.app.tar.gz
> ```
> - **必须在装有 `Developer ID Application` 证书的 Mac 上发布**。`prepack` 以 `LINKSHELL_REQUIRE_SIGNED=1` 构建：没有证书或签名失败，发布直接中止。签名身份和 bundle id（`com.bd.linkshell.host`）决定了权限记在谁名下，换掉等于让所有用户重新授权，不要换。
> - 包里装的是**压缩包**而不是 .app 本身：npm 包带不了 framework 里的符号链接，也保不住可执行权限。host 第一次用到时把它解到 `~/.linkshell/LinkShell.app`（`unpackedApp`），升级时原地替换。
> - 发布前抽检：`cd apps/mac && pnpm pack`，解开 tgz 再解开里面的 `build/LinkShell.app.tar.gz`，`codesign --verify --deep --strict LinkShell.app` 应无输出；`pnpm --filter @linkshell/mac check` 应全部通过。
> - Mac 上不再需要 ffmpeg（Linux 主机仍然用它）。
> - 只支持 Apple 芯片的 Mac（`cpu: arm64`），macOS 13 及以上；Intel Mac 上屏幕功能不可用，其余功能不受影响。

### 4.1 发布后立即抽检 tarball

每发完一个包，等它在 npm 上出现后下载下来检查，确认没有任何 `workspace:` 字面量泄漏：

```bash
# 替换成刚发的版本号
VERSION=0.10.0
GATEWAY_VERSION=0.6.0

cd "$(mktemp -d)"
npm pack linkshell-cli@$VERSION
tar -xzf linkshell-cli-$VERSION.tgz
grep -n "workspace:" package/package.json && echo "❌ workspace: leaked, DO NOT release; deprecate this version" || echo "✅ deps look clean"

# CLI 的包里不应该再有 web/（1.x 的网页控制台已经删除）
test -e package/web && echo "❌ web/ is back in the tarball: check files in packages/cli/package.json" || echo "✅ no web/"
rm -rf package

# 其他包同理：@linkshell/host → linkshell-host-X.Y.Z.tgz，@linkshell/gateway → linkshell-gateway-X.Y.Z.tgz，@linkshell/wire → linkshell-wire-X.Y.Z.tgz
npm pack @linkshell/gateway@$GATEWAY_VERSION
tar -xzf linkshell-gateway-$GATEWAY_VERSION.tgz
grep -n "workspace:" package/package.json && echo "❌ workspace: leaked" || echo "✅ deps look clean"
```

发现 `workspace:` 就立刻：

```bash
npm deprecate linkshell-cli@$VERSION "broken: workspace:* deps not rewritten; use next patch"
```

（哪个包泄漏就 deprecate 哪个包的那个版本。）然后 bump patch、改用 `pnpm publish` 重发。

最后装一遍真的：

```bash
npm i -g linkshell-cli@$VERSION --prefer-online
linkshell --version
linkshell doctor
```

## 5. 发布 Docker 镜像

Docker 镜像通过 GitHub Actions（`.github/workflows/docker-publish.yml`）构建发布。只需打 tag：

```bash
# 格式：gateway-vX.Y.Z，和 packages/gateway/package.json 的版本一致
git tag gateway-v0.6.0
git push origin gateway-v0.6.0
```

CI 会构建镜像并推送到 Docker Hub：`nickname4th/linkshell-gateway:0.6.0`、`:0.6`、`:latest`。

构建完成后验证镜像本身：

```bash
docker pull --platform linux/amd64 nickname4th/linkshell-gateway:0.6.0
docker run --platform linux/amd64 -d --name gw-check -p 18787:8787 -v gw-check:/data nickname4th/linkshell-gateway:0.6.0
curl -s http://127.0.0.1:18787/healthz     # {"ok":true,"version":"0.6.0","relay":0,…}
docker rm -f gw-check && docker volume rm gw-check
```

**打 tag 只是构建镜像，不会更新任何正在运行的网关。** 自建用户自己 `docker pull`；官方网关见下一节。

### Docker Hub 首次配置

1. 在 [Docker Hub](https://hub.docker.com/) 创建 `nickname4th/linkshell-gateway` 仓库
2. 在 GitHub repo Settings → Secrets 添加：
   - `DOCKERHUB_USERNAME`: Docker Hub 用户名
   - `DOCKERHUB_TOKEN`: Docker Hub Access Token（在 Docker Hub → Account Settings → Security 创建）

## 6. 部署官方网关（Luma）

官方网关 `gateway.itool.tech` 由 Luma 部署，清单是仓库根目录的 `luma-gateway.yml`，其中 `image:` 写死了镜像版本。所有 Pro 用户的电脑和手机都连着它：部署会断开所有连接（两端会自动重连），所以挑人少的时候做，做之前和之后都要看。

**部署前**

```bash
curl -s https://gateway.itool.tech/healthz
# 记下 version 和 relay（当前在线的连接数）

docker manifest inspect nickname4th/linkshell-gateway:X.Y.Z >/dev/null && echo "image exists"
```

确认 `luma-gateway.yml` 里这三处没有被动过：

- `volumes: - linkshell-gateway-relay:/data`
- `RELAY_DATA_PATH: /data/relay.db`
- `AUTH_REQUIRED: "true"` 和三个 `SUPABASE_*`

> ⚠️ **`/data/relay.db` 所在的卷绝不能丢、不能改名、不能换路径**。里面是每台电脑和手机的公钥、所属账号和配对关系：没了它，所有配对过的手机都要重新配对。入口不能换成一个读别的路径的程序，`RELAY_DATA_PATH` 也不能改：网关会在一个空数据库上正常启动，`/healthz` 一切正常，而所有人已经被解除配对。

**部署**

```bash
# 把 luma-gateway.yml 的 image 改成 nickname4th/linkshell-gateway:X.Y.Z
luma deploy luma-gateway.yml --dry-run
luma deploy luma-gateway.yml --timeout 3000

git add luma-gateway.yml
git commit -m "release: deploy gateway vX.Y.Z"
git push origin main
```

`SUPABASE_*` 在清单里是 `${…}` 占位符，由 Luma 的密钥库在服务端填入，本地不需要这些值。

**部署后**

```bash
curl -s https://gateway.itool.tech/healthz
# version 是新版本；relay 在一两分钟内回到部署前的水平（两端断线后会自动重试，间隔最长约 30 秒）
# 网关的启动日志里应该有一行：pairings and keys in /data/relay.db

linkshell host status      # 自己这台电脑：Gateway 一行是 online，账号正确
```

再拿一台**之前就配对好/登录好**的手机打开 App：电脑在线，能进会话，**没有被要求重新配对**。这一条是数据没丢的证明，`/healthz` 证明不了它。

**回滚**

把 `luma-gateway.yml` 的 `image:` 改回上一个版本（`git log -- luma-gateway.yml` 里能看到），重新 `luma deploy`，再做一遍“部署后”的检查。数据卷不动：只要表结构没变，旧镜像读的是同一个 `relay.db`。回滚时同样不要删卷、不要改 `RELAY_DATA_PATH`。

## 7. 更新 Homebrew Formula

npm 上能下载到新版本的 CLI 之后（脚本要下载 tarball 算 sha256），运行：

```bash
# 版本号取自 packages/cli/package.json，下载 tarball、算 sha256、更新 tap 仓库并推送
./scripts/update-brew.sh

# 或指定版本号
./scripts/update-brew.sh X.Y.Z
```

tap 仓库是 `LiuTianjie/homebrew-linkshell`，脚本每次都会重写其中的 `Formula/linkshell.rb`。用户安装：`brew install LiuTianjie/linkshell/linkshell`。

## 8. 移动端发版（apps/client）

发布的 App 是 `com.bd.linkshell`（App Store / APK 上的 LinkShell）。开发版用 `APP_VARIANT=development`（`pnpm --filter @linkshell/client ios|android` 已带上），装成 `com.bd.linkshell.v2`，与正式版并存。见 `apps/client/app.config.js`。

### 推荐：打 tag 走 CI

```bash
./scripts/release-mobile.sh 2.3.1
```

推送 `vX.Y.Z` 触发两个 self-hosted macOS workflow，都调用 `apps/client/scripts/release.mjs`：
- `.github/workflows/ios-build.yml` → prebuild、archive、上传 TestFlight
- `.github/workflows/android-build.yml` → AAB + APK，并创建 GitHub Release `LinkShell X.Y.Z`

版本号来自 tag：`version = X.Y.Z`，`buildNumber / versionCode = MAJOR*10000 + MINOR*100 + PATCH`。

### 本地构建（runner 离线时）

```bash
cd apps/client
node scripts/release.mjs ios 2.3.1        # 即根目录的 pnpm prod:ios；不带版本号时用 app.json 里的版本
node scripts/release.mjs android 2.3.1    # 即 pnpm prod:android；输出 build/release/LinkShell-X.Y.Z.apk / .aab
gh release create vX.Y.Z build/release/LinkShell-X.Y.Z.apk build/release/LinkShell-X.Y.Z.aab --title "LinkShell X.Y.Z"
```

- ⚠️ **本地构建完，要取消 CI 里的那两个构建**。`gh release create vX.Y.Z`（或手动推 `vX.Y.Z`）会在 GitHub 上产生这个 tag，照样触发 iOS 和 Android 两个 workflow，把同一个版本再构建、再上传一遍。推完马上 `gh run list --limit 5`，对这两个 run 执行 `gh run cancel <id>`。
- 每次都是从干净的 prebuild 开始的完整构建，没有“快速”版本。
- 在不是自己登录 shell 的环境里构建（脚本、后台任务）要补上环境变量，否则 CocoaPods / Gradle 一上来就失败：`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 ANDROID_HOME=$HOME/Library/Android/sdk`。
- Android release 用 Expo 模板的 `debug.keystore` 签名，和之前发布的所有版本相同，所以 APK 可以直接覆盖安装。
- iOS 需要本机 Xcode 登录了 team `L95PYLFT86`；上传后在 App Store Connect 处理完成才会出现在 TestFlight。
- 本地构建会重新生成 `ios/`、`android/`（正式版）；之后跑开发版需要 `APP_VARIANT=development npx expo prebuild --clean`。

README 和官网上的 Android 下载链接指向 GitHub 的 `releases/latest`：**最新的 Release 必须是带 APK 的 App 版本**。

## 9. 提交 & 打 Tag

```bash
git add -A
git commit -m "release: cli X.Y.Z, host X.Y.Z, gateway X.Y.Z"    # 发了哪些写哪些
git tag cli-vX.Y.Z
git push origin main cli-vX.Y.Z
```

- tag 按名字推，不要用 `--tags`：本地如果留着一个没推过的 `vX.Y.Z`，`--tags` 会顺手触发一次 App 构建。
- CLI 发版只打 tag，不建 GitHub Release（原因见上一节末尾）。确实要建的话加 `--latest=false`：`gh release create cli-vX.Y.Z --latest=false --title "cli X.Y.Z" --notes "…"`。

## 10. 发版后验证

```bash
# npm
npm view linkshell-cli version
npm view @linkshell/host version
npm view @linkshell/gateway version

# 升级路径：在一台装着上一个版本的机器上
linkshell upgrade
linkshell host stop && linkshell host --daemon     # 后台的 host 还在跑旧版本，重启后才是新的
linkshell doctor                                    # Host 一行的版本号和 CLI 一致，Gateway 一行 online
linkshell host status

# 全新安装
curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh
brew update && brew upgrade linkshell

# Docker（如果发了 gateway）
docker pull --platform linux/amd64 nickname4th/linkshell-gateway:latest
curl -s https://gateway.itool.tech/healthz          # 如果部署了官方网关
```

改了屏幕相关的代码时，在 Mac 上再跑一次 `linkshell screen --check`，并用手机实际看一次屏幕。

## 快速发版 Checklist

- [ ] `pnpm build`、`pnpm typecheck`、`pnpm test` 全部通过
- [ ] 版本号已更新（wire、mac、host、gateway、cli 中改动过的，以及它们的下游；根 package.json 跟 CLI 一致）
- [ ] 改版本号之后重新 `pnpm build`
- [ ] **使用 `pnpm publish`（不是 `npm publish`）**，顺序 wire → mac → host → gateway → cli
- [ ] `@linkshell/mac` 是在有 Developer ID 证书的 Mac 上发的
- [ ] 抽检 tarball：没有 `workspace:`；CLI 包里没有 `web/`（见 §4.1）
- [ ] `npm i -g linkshell-cli@X.Y.Z --prefer-online` 能装上，`linkshell doctor` 通过
- [ ] 如果发了 gateway：`gateway-vX.Y.Z` tag 已推送，镜像本地跑过 `/healthz`
- [ ] 如果要更新官方网关：`luma-gateway.yml` 已改并部署；`/healthz` 是新版本、`relay` 回升；一台已配对的手机不用重新配对就能连上
- [ ] Homebrew formula 已更新
- [ ] `cli-vX.Y.Z` tag 已推送（按名字推，没有用 `--tags`）
- [ ] App 有改动时：`vX.Y.Z` 已发，TestFlight 和 GitHub Release（带 APK）都在；本地构建的话 CI 里重复的构建已取消
- [ ] README、README_CN、docs/site（改完跑 `python3 scripts/build-site-pages.py`）、包级 README 已同步新功能

## 仅准备制品（不发布）

需要先准备制品、延后正式发布时，可以使用下面的独立流程：

- `Prepare release artifacts` 工作流执行构建、类型检查、lint、测试，生成 wire、host、gateway、cli 四个 npm tarball 与 iOS / Android JavaScript bundle，只上传到 Actions artifacts，不执行 npm publish、不创建 Release、不上传商店。
- 本次包含 Mac 组件改动：需先在有 Developer ID 证书的 Mac 上执行 `pnpm --filter @linkshell/mac pack --pack-destination <制品目录>`，一起交付 `@linkshell/mac@0.1.1`。Linux 流水线不会生成这个签名包。
- 原生包在有签名环境的 Mac 上执行 `node scripts/release.mjs ios 2.3.7 --prepare-only` 和 `node scripts/release.mjs android 2.3.7 --prepare-only`。必须在独立干净检出里执行，因为 prebuild 会重新生成原生目录。iOS 导出 IPA，不上传 App Store Connect；Android 只生成 AAB / APK。
- 不推送 `v*` tag：原有 tag 工作流包含 TestFlight 上传和公开 GitHub Release。
- `python3 scripts/check-release-packages.py <tarball目录>` 核对版本依赖和 workspace 重写。完成正式发布并核验远端状态后，才能称为已上线。
