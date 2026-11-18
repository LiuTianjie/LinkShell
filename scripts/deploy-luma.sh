#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export LUMA_BUILD_URL="${LUMA_BUILD_URL:-https://build.itool.tech}"
# Build the committed revision selected by the caller; it must already be pushed.
ref="${LUMA_REF:-$(git rev-parse HEAD)}"
exec luma builder submit https://github.com/LiuTianjie/LinkShell.git \
  --provider-id github:LiuTianjie --ref "$ref" \
  --manifest-path luma-gateway.yml --platform linux/amd64 --workflow-app linkshell-gateway "$@"
