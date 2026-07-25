# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No env vars are read at module scope during the build -- db.ts's pool and
# vertex.ts's Vertex client are both lazy singletons for exactly this
# reason (see Phase 7: `next build` imports every route module to collect
# page data, before Cloud Run injects real secrets).
RUN npm run build

# This one image serves both the Cloud Run web service (`node server.js`,
# Next's standalone output) and Cloud Run Jobs (`npx tsx
# src/agents/runner.ts`, selected by overriding the container command at
# deploy time). Because the jobs entrypoint needs the full dependency tree
# (pg, @google/genai, tsx itself) and most of it overlaps with what the web
# server needs anyway, this stage ships full node_modules rather than a
# minimal standalone-only tree -- "standalone" here buys the conventional
# server.js entrypoint, not a smaller image.
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/src ./src
COPY --from=builder /app/db ./db
COPY --from=builder /app/tsconfig.json ./tsconfig.json

EXPOSE 8080

# Cloud Run's web service uses this default command as-is. Cloud Run Jobs
# overrides it per schedule, e.g.:
#   --command=npx --args=tsx,src/agents/runner.ts
#   --set-env-vars=AGENT=course-sync
CMD ["node", "server.js"]
