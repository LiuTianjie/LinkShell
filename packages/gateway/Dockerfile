FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# pnpm checks every patched dependency in the lockfile against its patch file.
COPY patches/ patches/
COPY packages/wire/package.json packages/wire/
COPY packages/gateway/package.json packages/gateway/
COPY packages/client-core/package.json packages/client-core/
COPY apps/web/package.json apps/web/

RUN pnpm install --frozen-lockfile --filter @linkshell/gateway --filter @linkshell/wire --filter @linkshell/client-core --filter @linkshell/web

COPY packages/wire/ packages/wire/
COPY packages/gateway/ packages/gateway/
COPY tsconfig.base.json ./
COPY packages/client-core/ packages/client-core/
COPY apps/web/ apps/web/
COPY apps/client/src/ apps/client/src/

# The wire protocol first: the gateway runs against its built dist.
RUN pnpm --filter @linkshell/wire build \
  && pnpm --filter @linkshell/gateway build \
  && pnpm --filter @linkshell/gateway build:web

# Prune to production deps only (the app's patches don't apply to the gateway).
RUN pnpm --filter @linkshell/gateway deploy --legacy --prod --config.allow-unused-patches=true /app/pruned

# ── Runtime ──────────────────────────────────────────────────────────

FROM node:22-alpine

LABEL org.opencontainers.image.source="https://github.com/LiuTianjie/LinkShell"
LABEL org.opencontainers.image.description="LinkShell Gateway — relays end-to-end encrypted frames between computers and phones, and brokers pairing"

RUN addgroup -S linkshell && adduser -S linkshell -G linkshell

WORKDIR /app

# Copy pruned production node_modules + built dist
COPY --from=builder /app/pruned/node_modules node_modules/
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist/
COPY --from=builder /app/packages/gateway/web-client packages/gateway/web-client/
# Also where /healthz reads the version from.
COPY --from=builder /app/packages/gateway/package.json packages/gateway/

# Workspace root package.json needed for module resolution
COPY --from=builder /app/package.json ./

# Pairings and keys are kept here: mount a persistent volume.
RUN mkdir -p /data && chown -R linkshell:linkshell /app /data
USER linkshell

ENV NODE_ENV=production
ENV PORT=8787
ENV RELAY_DATA_PATH=/data/relay.db
# Collect garbage well inside a 768 MB container instead of growing into its limit.
ENV NODE_OPTIONS=--max-old-space-size=512
EXPOSE 8787

CMD ["node", "packages/gateway/dist/gateway/src/main.js"]
