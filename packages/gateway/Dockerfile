FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared-protocol/package.json packages/shared-protocol/
COPY packages/gateway/package.json packages/gateway/

RUN pnpm install --frozen-lockfile --filter @linkshell/gateway --filter @linkshell/protocol

COPY packages/shared-protocol/ packages/shared-protocol/
COPY packages/gateway/ packages/gateway/
COPY tsconfig.base.json ./

RUN pnpm --filter @linkshell/protocol build && pnpm --filter @linkshell/gateway build

# Prune to production deps only
RUN pnpm --filter @linkshell/gateway deploy --prod /app/pruned

# ── Runtime ──────────────────────────────────────────────────────────

FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/LiuTianjie/LinkShell"
LABEL org.opencontainers.image.description="LinkShell Gateway — WebSocket relay for remote terminal sessions"

RUN addgroup -S linkshell && adduser -S linkshell -G linkshell

WORKDIR /app

# Copy pruned production node_modules + built dist
COPY --from=builder /app/pruned/node_modules node_modules/
COPY --from=builder /app/packages/shared-protocol/dist packages/shared-protocol/dist/
COPY --from=builder /app/packages/shared-protocol/package.json packages/shared-protocol/
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist/
COPY --from=builder /app/packages/gateway/package.json packages/gateway/

# Workspace root package.json needed for module resolution
COPY --from=builder /app/package.json ./

RUN chown -R linkshell:linkshell /app
USER linkshell

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

CMD ["node", "packages/gateway/dist/gateway/src/index.js"]
