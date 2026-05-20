# ── Stage 1: builder ─────────────────────────────────────────────────────────
# Installs all dependencies (including devDeps), generates the Prisma client,
# compiles TypeScript, then prunes dev-only packages.
# This stage is also used by the dev docker-compose as-is (source mounted over).
FROM node:20-alpine AS builder

# sharp (libvips) and Prisma engines need these on Alpine
RUN apk add --no-cache python3 make g++ libc6-compat

WORKDIR /app

# Copy manifests first — Docker caches this layer until package.json changes
COPY package*.json ./
COPY prisma.config.ts ./
COPY prisma/ ./prisma/

# Install everything (dev + prod) so tsc and prisma CLI are available
RUN npm ci

# Generate Prisma client inside the Linux container
# (prevents macOS-compiled binaries from being carried into the image)
RUN npx prisma generate

# Compile TypeScript → dist/
COPY . .
RUN npm run build

# Remove dev-only packages; @prisma/client stays (it's in dependencies)
RUN npm prune --production


# ── Stage 2: production ───────────────────────────────────────────────────────
# Minimal runtime image. No build tools, no source files, no dev packages.
# Runs as a non-root user for defence-in-depth.
FROM node:20-alpine AS production

RUN apk add --no-cache libc6-compat wget

WORKDIR /app

# Non-root user
RUN addgroup -g 1001 -S nodejs \
 && adduser  -u 1001 -S velvet -G nodejs

# Copy only what's needed at runtime
COPY --from=builder --chown=velvet:nodejs /app/dist          ./dist
COPY --from=builder --chown=velvet:nodejs /app/node_modules  ./node_modules
COPY --from=builder --chown=velvet:nodejs /app/package.json  ./
# Prisma needs the schema file at runtime for query engine resolution
COPY --from=builder --chown=velvet:nodejs /app/prisma        ./prisma
COPY --from=builder --chown=velvet:nodejs /app/prisma.config.ts ./

USER velvet

EXPOSE 3002

# Health check hits the lightweight /live endpoint (no DB I/O)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget -qO- http://localhost:3002/live || exit 1

CMD ["node", "dist/server.js"]
