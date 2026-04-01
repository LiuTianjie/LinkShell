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

# ── Runtime ──────────────────────────────────────────────────────────

FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@10.18.3 --activate

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/shared-protocol/package.json packages/shared-protocol/
COPY packages/gateway/package.json packages/gateway/

RUN pnpm install --frozen-lockfile --filter @linkshell/gateway --filter @linkshell/protocol --prod

COPY --from=builder /app/packages/shared-protocol/dist packages/shared-protocol/dist
COPY --from=builder /app/packages/gateway/dist packages/gateway/dist

ENV PORT=8787
EXPOSE 8787

CMD ["node", "packages/gateway/dist/gateway/src/index.js"]
