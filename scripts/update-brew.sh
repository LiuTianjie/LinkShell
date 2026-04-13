#!/bin/bash
# Update Homebrew formula after npm publish
# Usage: ./scripts/update-brew.sh [version]
set -e

VERSION=${1:-$(node -e "console.log(require('./packages/cli/package.json').version)")}
TARBALL_URL="https://registry.npmjs.org/linkshell-cli/-/linkshell-cli-${VERSION}.tgz"
TAP_DIR="/tmp/homebrew-linkshell"

echo "Updating Homebrew formula for v${VERSION}..."

# Download and hash
curl -sL -o /tmp/linkshell-cli.tgz "$TARBALL_URL"
SHA=$(shasum -a 256 /tmp/linkshell-cli.tgz | awk '{print $1}')
echo "SHA256: ${SHA}"

# Clone or pull tap repo
if [ -d "$TAP_DIR" ]; then
  cd "$TAP_DIR" && git pull origin main
else
  git clone https://github.com/LiuTianjie/homebrew-linkshell.git "$TAP_DIR"
  cd "$TAP_DIR"
fi

# Update formula
cat > Formula/linkshell.rb << RUBY
class Linkshell < Formula
  desc "Remote terminal bridge — control local CLI sessions from your phone"
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
rm -f /tmp/linkshell-cli.tgz
