# LinkShell 发版 SOP

## 版本号规范

- CLI: `linkshell-cli@x.y.z`
- Gateway: `@linkshell/gateway@x.y.z`
- Protocol: `@linkshell/protocol@x.y.z`
- Docker tag: `gateway-vx.y.z`

## 1. 发版前检查

```bash
# 确保代码干净
git status

# 类型检查
pnpm typecheck

# 本地测试
pnpm dev:cli start --provider custom --command bash
```

## 2. 更新版本号

```bash
# 更新 packages/cli/package.json 的 version
# 更新 packages/gateway/package.json 的 version
# 更新 packages/shared-protocol/package.json 的 version
# 如果有 breaking change，同步更新根 package.json
```

## 3. 构建

```bash
pnpm build
```

## 4. 发布 npm 包

```bash
# 发布 protocol（如果有改动）
cd packages/shared-protocol
npm publish --access public

# 发布 gateway（如果有改动）
cd ../gateway
npm publish --access public

# 发布 CLI
cd ../cli
npm publish --access public
```

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

## 7. 移动端发版

### iOS

```bash
cd apps/mobile
pnpm prod:ios
```

脚本会自动 bump iOS build number、prebuild、archive，并上传到 App Store Connect。若 App Store Connect 提示当前 train 已关闭，需要先提高 `expo.version`，再重新构建上传。

### Android

```bash
cd apps/mobile
pnpm prod:android:apk
```

将 APK 上传到 GitHub Releases。

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

如果有 Android APK，附加到 Release：

```bash
gh release upload vX.Y.Z ./apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

## 10. 发版后验证

```bash
# 验证 npm
npm info linkshell-cli version

# 验证 Docker
docker pull nickname4th/linkshell-gateway:latest
docker run --rm nickname4th/linkshell-gateway:latest node -e "console.log('ok')"

# 验证 Homebrew（首次 tap 后）
brew update
brew upgrade linkshell

# 验证 curl 安装
curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh

# 验证 upgrade 命令
linkshell upgrade
```

## 快速发版 Checklist

- [ ] 代码通过 typecheck
- [ ] 版本号已更新
- [ ] `pnpm build` 成功
- [ ] npm 包已发布
- [ ] Docker tag 已推送（CI 自动构建）
- [ ] Homebrew formula 已更新 sha256
- [ ] GitHub Release 已创建
- [ ] 移动端已提交（如有改动）
