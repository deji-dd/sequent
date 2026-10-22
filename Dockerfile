# Multi-stage optimized Bun Dockerfile for Sequent
FROM oven/bun:1.4.4 AS base
WORKDIR /app

# Install all dependencies (including dev deps, required to build the UI)
FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Build static frontend
FROM dependencies AS builder
WORKDIR /app
COPY tsconfig.json vite.config.ts ./
COPY ui ./ui
COPY src ./src
RUN bun run build

# Production-only dependencies for the runtime image
FROM base AS production-dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Production runner
FROM base AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3003

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json tsconfig.json ./
COPY src ./src

USER bun

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:3003/api/health || exit 1

CMD ["bun", "run", "src/index.ts"]
