#!/bin/bash
# Release the mobile app (iOS + Android) by pushing a vX.Y.Z tag.
#
# Pushing `vX.Y.Z` triggers two self-hosted-macOS workflows:
#   - .github/workflows/ios-build.yml     → archive + upload to TestFlight
#   - .github/workflows/android-build.yml → AAB + APK → GitHub Release "LinkShell X.Y.Z"
#
# The tag is the single source of truth: CI parses the version from it, rewrites
# app.json (version + ios.buildNumber + android.versionCode = MAJOR*10000+MINOR*100+PATCH)
# in its own checkout, and creates the GitHub Release. This script therefore does
# NOT touch app.json and does NOT create a Release — it only validates, tags, pushes.
#
# Usage:
#   ./scripts/release-mobile.sh 1.1.5            # tag HEAD as v1.1.5 and push
#   ./scripts/release-mobile.sh                  # auto-suggest next patch, then confirm
#   ./scripts/release-mobile.sh 1.1.5 --yes      # skip confirmation prompt
#   ./scripts/release-mobile.sh 1.1.5 --skip-typecheck
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Parse args ──────────────────────────────────────────────────────
VERSION=""
ASSUME_YES=0
SKIP_TYPECHECK=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)        ASSUME_YES=1 ;;
    --skip-typecheck) SKIP_TYPECHECK=1 ;;
    -*)              echo "Unknown flag: $arg" >&2; exit 1 ;;
    *)               VERSION="$arg" ;;
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
  echo "✗ Version must be X.Y.Z (e.g. 1.1.5), got: '$VERSION'" >&2
  exit 1
fi
TAG="v$VERSION"

# ── Pre-checks ──────────────────────────────────────────────────────
# Tag points at HEAD's commit; uncommitted changes are NOT included in the build.
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "main" ]]; then
  echo "⚠️  You are on branch '$BRANCH', not 'main'. The tag will point at this branch's HEAD."
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠️  Working tree has uncommitted changes — they will NOT be in the build (tag points at the last commit):"
  git status -s
fi

# Local tag conflict
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "✗ Tag $TAG already exists locally. Delete it first: git tag -d $TAG" >&2
  exit 1
fi
# Remote tag conflict
if git ls-remote --tags origin "$TAG" 2>/dev/null | grep -q "refs/tags/$TAG"; then
  echo "✗ Tag $TAG already exists on origin. Pick a higher version." >&2
  exit 1
fi

# Compute build number CI will assign, so you see it before pushing.
IFS='.' read -r MA MI PA <<< "$VERSION"
BUILD_CODE=$((MA * 10000 + MI * 100 + PA))

# Typecheck the mobile app (skippable for hotfix re-tags).
if [[ "$SKIP_TYPECHECK" -eq 0 ]]; then
  echo
  echo "━━━ Typecheck (mobile app) ━━━"
  pnpm --filter @linkshell/app typecheck
else
  echo "━━━ Typecheck skipped (--skip-typecheck) ━━━"
fi

# ── Confirm ─────────────────────────────────────────────────────────
HEAD_SHA="$(git rev-parse --short HEAD)"
HEAD_MSG="$(git log -1 --pretty=%s)"
echo
echo "──────────────────────────────────────────────"
echo "  Release mobile $TAG"
echo "  version       : $VERSION"
echo "  buildNumber   : $BUILD_CODE   (ios.buildNumber & android.versionCode, set by CI)"
echo "  HEAD          : $HEAD_SHA  $HEAD_MSG"
echo "  triggers      : iOS → TestFlight,  Android → GitHub Release (AAB+APK)"
echo "──────────────────────────────────────────────"
if [[ "$ASSUME_YES" -eq 0 ]]; then
  printf "Push %s now? [y/N] " "$TAG"
  read -r REPLY
  case "$REPLY" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 0 ;;
  esac
fi

# ── Tag & push ──────────────────────────────────────────────────────
git tag -a "$TAG" -m "release: $TAG"
git push origin "$TAG"
echo "✓ Pushed $TAG"

# ── Show triggered CI runs ──────────────────────────────────────────
if command -v gh >/dev/null 2>&1; then
  echo
  echo "Waiting for CI to register the runs..."
  sleep 5
  gh run list --limit 5 || true
  echo
  echo "Watch:   gh run watch   (pick a run)   |   App Store Connect → TestFlight   |   GitHub → Releases"
else
  echo "Install gh CLI to auto-show CI status, or check: GitHub → Actions"
fi
