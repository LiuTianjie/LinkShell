#!/bin/bash
# Update Homebrew formula after npm publish
# Usage: ./scripts/update-brew.sh [version]
set -e

VERSION=${1:-$(node -e "console.log(require('./packages/cli/package.json').version)")}
TARBALL_URL="https://registry.npmjs.org/linkshell-cli/-/linkshell-cli-${VERSION}.tgz"
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/linkshell-brew.XXXXXX")
trap 'rm -rf "$WORK_DIR"' EXIT
TAP_DIR="$WORK_DIR/tap"
TARBALL="$WORK_DIR/linkshell-cli.tgz"

echo "Updating Homebrew formula for v${VERSION}..."

# Download and hash
curl -fsSL -o "$TARBALL" "$TARBALL_URL"
tar -tzf "$TARBALL" >/dev/null
SHA=$(shasum -a 256 "$TARBALL" | awk '{print $1}')
echo "SHA256: ${SHA}"

# Own this checkout so a release never reuses someone else's dirty tap.
git clone --depth 1 https://github.com/LiuTianjie/homebrew-linkshell.git "$TAP_DIR"
cd "$TAP_DIR"

# Update formula
cat > Formula/linkshell.rb << RUBY
class Linkshell < Formula
  desc "Follow, steer and approve the coding agents on your computer from your phone"
  homepage "https://github.com/LiuTianjie/LinkShell"
  url "https://registry.npmjs.org/linkshell-cli/-/linkshell-cli-${VERSION}.tgz"
  sha256 "${SHA}"
  license "MIT"

  depends_on "node@22"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec/"bin/linkshell"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/linkshell --version")
  end
end
RUBY

git add Formula/linkshell.rb
git commit -m "bump: linkshell ${VERSION}"
git push origin main

echo "Done! Formula updated to v${VERSION}"
