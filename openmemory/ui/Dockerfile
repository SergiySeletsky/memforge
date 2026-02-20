# syntax=docker.io/docker/dockerfile:1

# Base stage for common setup
FROM node:18-alpine AS base

# Install dependencies for pnpm and native modules (better-sqlite3)
RUN apk add --no-cache libc6-compat curl python3 make g++ && \
    corepack enable && \
    corepack prepare pnpm@latest --activate

WORKDIR /app

FROM base AS deps

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/pnpm-lock.yaml ./pnpm-lock.yaml
COPY . .

# Use the main next.config.mjs which includes serverExternalPackages for
# better-sqlite3, mem0ai, sqlite3 and webpack client-side fallbacks.
# (Do NOT overwrite with next.config.dev.mjs — that lacks the merged config.)

# Build with placeholders so we can safely inject runtime values in the final image.
# Next.js inlines NEXT_PUBLIC_* values at build time, so we must ensure the
# built output contains a stable marker we can replace on container start.
RUN printf "NEXT_PUBLIC_USER_ID=__NEXT_PUBLIC_USER_ID__\n" > .env
RUN pnpm build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Copy native better-sqlite3 bindings into standalone output
COPY --from=builder /app/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=builder /app/node_modules/bindings ./node_modules/bindings
COPY --from=builder /app/node_modules/file-uri-to-path ./node_modules/file-uri-to-path

# Create data directory for SQLite database
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data

# `sed -i` creates temp files in the target directory; ensure /app is writable.
RUN chown -R nextjs:nodejs /app

USER nextjs

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# NOTE:
# We intentionally do not execute a repo-provided shell script here.
# On Windows checkouts, CRLF/BOM can cause "no such file or directory" at runtime.
# Instead, inline the small placeholder-replacement logic.
ENTRYPOINT ["sh", "-c", "cd /app; printenv | grep '^NEXT_PUBLIC_' | while IFS= read -r line; do key=$(printf '%s' \"$line\" | cut -d '=' -f1); value=$(printf '%s' \"$line\" | cut -d '=' -f2-); placeholder=\"__${key}__\"; escaped=$(printf '%s' \"$value\" | sed -e 's/[&|]/\\\\&/g'); find . -type f -exec sed -i \"s|$placeholder|$escaped|g\" {} \\; ; done; echo 'Done replacing NEXT_PUBLIC_ placeholders with real values'; exec node server.js"]
