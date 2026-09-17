# Multi-stage optimized Bun Dockerfile for Sequent
FROM oven/bun:latest AS base
WORKDIR /app

# Install dependencies
FROM base AS dependencies
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

# Build static frontend
FROM dependencies AS builder
WORKDIR /app
COPY package.json tsconfig.json vite.config.ts ./
COPY ui ./ui
COPY src ./src
RUN bun run build

# Production runner
FROM base AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3003

COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src

EXPOSE 3003

CMD ["bun", "run", "src/index.ts"]
