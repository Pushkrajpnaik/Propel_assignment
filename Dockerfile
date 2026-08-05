FROM node:20-alpine AS fe-deps
WORKDIR /fe
COPY frontend/package*.json ./
RUN npm ci

FROM node:20-alpine AS fe-builder
WORKDIR /fe
COPY --from=fe-deps /fe/node_modules ./node_modules
COPY frontend .
# Build with relative API url (same origin) — app uses /api which Express will serve
ENV VITE_API_URL=
RUN npm run build

FROM node:20-alpine AS be-deps
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl
COPY backend/package*.json ./
RUN npm ci --omit=dev=false

FROM node:20-alpine AS be-builder
WORKDIR /app
COPY --from=be-deps /app/node_modules ./node_modules
COPY backend .
ENV NODE_ENV=production
RUN npx prisma generate && npx tsc

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0
RUN apk add --no-cache openssl bash tini curl

COPY --from=be-builder /app/node_modules ./node_modules
COPY --from=be-builder /app/dist ./dist
COPY --from=be-builder /app/package.json ./package.json
COPY --from=be-builder /app/prisma ./prisma
COPY backend/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Embed built frontend — Express serves it as static files at /
COPY --from=fe-builder /fe/dist ./public

EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
  CMD curl -fsS http://127.0.0.1:${PORT:-3000}/api/health || exit 1
