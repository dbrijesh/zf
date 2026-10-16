# One image for the API (serves the web app), the worker and the zf CLI.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production ZF_DATA_DIR=/data PORT=8787
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 1000 zf && mkdir -p /data && chown zf:zf /data
COPY --from=build --chown=zf:zf /app /app
USER zf
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD curl -fsS http://localhost:8787/api/v1/health || exit 1
CMD ["node_modules/.bin/tsx", "apps/api/src/main.ts"]