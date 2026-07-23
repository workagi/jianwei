FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# Use registry mirror for China network; npm install -g works around corepack hardcoding npmjs.org
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pnpm@10.28.1 && \
    pnpm config set registry https://registry.npmmirror.com

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# esbuild is a transitive dependency; pnpm's isolated linker won't expose its bin.
# Link it manually so build:worker can find it.
RUN ESBUILD_BIN=$(find /app/node_modules/.pnpm -name esbuild -type f -path '*/bin/esbuild' 2>/dev/null | head -1) && \
    if [ -n "$ESBUILD_BIN" ]; then ln -sf "$ESBUILD_BIN" /usr/local/bin/esbuild; fi
COPY . .
RUN mkdir -p public && pnpm build && pnpm build:worker

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

FROM base AS tools
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/dist ./dist
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs   && adduser --system --uid 1001 nextjs   && chown -R nextjs:nodejs /app   && mkdir -p /home/nextjs/.cache/node   && cp -R /root/.cache/node/corepack /home/nextjs/.cache/node/corepack   && chown -R nextjs:nodejs /home/nextjs/.cache
USER nextjs
CMD ["pnpm", "worker"]
