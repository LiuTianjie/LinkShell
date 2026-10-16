#!/bin/bash
# Release the mobile app (iOS + Android) locally from this Mac. (apps/client)
#
# Runs:
#   - node apps/client/scripts/release.mjs ios <version>     → archive + upload to TestFlight
#   - node apps/client/scripts/release.mjs android <version> → AAB + APK in apps/client/build/release
#   - gh release create v<version> ...                       → GitHub Release "LinkShell <version>"
#
# Usage:
#   ./scripts/release-mobile.sh 2.3.28           # build & publish v2.3.28 locally
#   ./scripts/release-mobile.sh                  # auto-suggest next patch, then confirm
#   ./scripts/release-mobile.sh 2.3.28 --yes     # skip confirmation prompt
#   ./scripts/release-mobile.sh 2.3.28 --skip-typecheck
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"

# ── Parse args ──────────────────────────────────────────────────────
VERSION=""
ASSUME_YES=0
SKIP_TYPECHECK=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)         ASSUME_YES=1 ;;
    --skip-typecheck) SKIP_TYPECHECK=1 ;;
    -*)               echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)                VERSION="$arg" ;;
  esac
done

# ── Resolve version (auto-suggest next patch from latest vX.Y.Z tag) ─
if [[ -z "$VERSION" ]]; then
  git fetch --tags --quiet 2>/dev/null || true
  LATEST="$(git tag -l 'v*.*.*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)"
  if [[ -n "$LATEST" ]]; then
    BASE="${LATEST#v}"
    IFS='.' read -r MA MI PA <<< "$BASE"
    VERSION="${MA}.${MI}.$((PA + 1))"
    echo "Latest mobile tag: $LATEST  →  suggesting v$VERSION"
  else
    echo "No vX.Y.Z tag found. Pass a version explicitly: ./scripts/release-mobile.sh 1.0.0" >&2
    exit 1
  fi
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "✗ Version must be X.Y.Z (e.g. 2.3.28), got: '$VERSION'" >&2
  exit 1
fi
TAG="v$VERSION"

IFS='.' read -r MA MI PA <<< "$VERSION"
BUILD_CODE=$((MA * 10000 + MI * 100 + PA))

if [[ "$SKIP_TYPECHECK" -eq 0 ]]; then
  echo
  echo "━━━ Typecheck (mobile app) ━━━"
  pnpm --filter @linkshell/client typecheck
else
  echo "━━━ Typecheck skipped (--skip-typecheck) ━━━"
fi

HEAD_SHA="$(git rev-parse --short HEAD)"
HEAD_MSG="$(git log -1 --pretty=%s)"
echo
echo "──────────────────────────────────────────────"
echo "  Local Mobile Release $TAG"
echo "  version       : $VERSION"
echo "  buildNumber   : $BUILD_CODE   (ios.buildNumber & android.versionCode)"
echo "  HEAD          : $HEAD_SHA  $HEAD_MSG"
echo "  actions       : local iOS → TestFlight, local Android → GitHub Release (AAB+APK)"
echo "──────────────────────────────────────────────"
if [[ "$ASSUME_YES" -eq 0 ]]; then
  printf "Build and release %s locally now? [y/N] " "$TAG"
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

trap 'git checkout -- apps/client/app.json 2>/dev/null || true' EXIT

echo
echo "━━━ Building workspace packages ━━━"
pnpm -r --filter './packages/*' build

echo
echo "━━━ Building iOS & uploading to TestFlight ($VERSION) ━━━"
(cd apps/client && node scripts/release.mjs ios "$VERSION")

echo
echo "━━━ Building Android AAB + APK ($VERSION) ━━━"
(cd apps/client && node scripts/release.mjs android "$VERSION")

git checkout -- apps/client/app.json 2>/dev/null || true

echo
echo "━━━ Publishing GitHub Release $TAG ━━━"
AAB="apps/client/build/release/LinkShell-${VERSION}.aab"
APK="apps/client/build/release/LinkShell-${VERSION}.apk"
if gh release view "$TAG" >/dev/null 2>&1; then
  gh release upload "$TAG" "$APK" "$AAB" --clobber
else
  gh release create "$TAG" "$APK" "$AAB" --title "LinkShell ${VERSION}" --notes "LinkShell ${VERSION}"
fi
echo "✓ Released $TAG (TestFlight + GitHub Release)"
