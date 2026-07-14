FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]

# Full toolchain image for the one-shot migration runner and the long-running
# collector worker. Reuses the complete dependency tree from the deps stage
# (including dev deps: tsx + drizzle-kit), since the standalone runtime above
# only ships the trimmed Next.js server, not the worker source or tsx.
FROM base AS tools
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs \
  && chown -R nextjs:nodejs /app \
  && mkdir -p /home/nextjs/.cache/node \
  && cp -R /root/.cache/node/corepack /home/nextjs/.cache/node/corepack \
  && chown -R nextjs:nodejs /home/nextjs/.cache
USER nextjs
# The root image layer already downloaded pnpm via corepack; copy that cache to
# the non-root user above so `pnpm worker` / `pnpm db:migrate` start offline.

# command is overridden per-service in compose: migrate runs `pnpm db:migrate`,
# worker runs `pnpm worker`.
CMD ["pnpm", "worker"]
