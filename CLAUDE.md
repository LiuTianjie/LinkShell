# LinkShell

Remote terminal bridge — control local CLI sessions from your phone.

## Project Structure

- `packages/cli` — CLI (PTY, built-in Gateway, daemon, login/upgrade)
- `packages/gateway` — Cloud gateway (pairing, sessions, routing, auth middleware)
- `packages/shared-protocol` — Shared protocol (Zod schema, message types)
- `apps/mobile` — Expo App (React Native, xterm.js)
- `apps/web-dashboard` — Web dashboard (Vite + React + Tailwind)

## Build & Dev

```bash
pnpm install
pnpm build                # Build all packages
pnpm typecheck            # Type check all packages
pnpm dev:gateway          # Dev gateway (localhost:8787)
pnpm dev:cli              # Dev CLI
pnpm dev:app              # Dev mobile app (Expo)
```

## Mobile Build

- iOS: `pnpm prod:ios` (full prebuild, never use `prod:ios:quick`)
- Android: `pnpm prod:android` or `pnpm prod:android:apk`

## Release

See [docs/release-sop.md](docs/release-sop.md) for the full release checklist.

Key steps:
1. `pnpm build && pnpm typecheck`
2. npm publish (protocol → gateway → cli)
3. `git tag gateway-vX.Y.Z && git push origin gateway-vX.Y.Z` (triggers Docker Hub CI)
4. `./scripts/update-brew.sh` (auto-updates Homebrew tap with new sha256)
5. Create GitHub Release

## Distribution Channels

- **npm**: `npm install -g linkshell-cli`
- **Homebrew**: `brew install LiuTianjie/linkshell/linkshell` (tap: [homebrew-linkshell](https://github.com/LiuTianjie/homebrew-linkshell))
- **curl**: `curl -fsSL https://liutianjie.github.io/LinkShell/install.sh | sh`
- **Docker Hub**: `nickname4th/linkshell-gateway` (CI: `.github/workflows/docker-publish.yml`, triggered by `gateway-v*` tags)
- **GitHub Pages**: `docs/site/` deployed via `.github/workflows/pages.yml`

## Auth & Backend

- Supabase project: `mkbeusztkzffnzjdwmqk` (shared with iTool)
- Tables: `linkshell_device_tokens`, `linkshell_official_gateways` (+ iTool's `profiles` for subscription)
- Gateway auth: `AUTH_REQUIRED=true` env var enables JWT validation + subscription check via `auth-middleware.ts`
- Gateway env vars for official deployment: `AUTH_REQUIRED`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- CLI auth: `~/.linkshell/auth.json`, commands `linkshell login` (iTool OAuth) / `linkshell logout` / `linkshell list`
- Subscription check: queries iTool's `profiles.plan` + `profiles.plan_expires_at`

## Conventions

- Commit style: `feat:`, `fix:`, `docs:`, `release:`
- Chinese UI text in mobile app
- English in README.md, Chinese in README_CN.md
