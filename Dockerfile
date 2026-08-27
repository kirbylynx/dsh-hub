FROM node:24-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/dsh-hub-service/package.json packages/dsh-hub-service/package.json
COPY packages/dsh-hub-client/package.json packages/dsh-hub-client/package.json

RUN npm ci --omit=dev

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY packages ./packages

RUN mkdir -p /data && chown -R node:node /app /data
USER node

EXPOSE 8081
CMD ["node", "packages/dsh-hub-service/bin/dsh-hub-service.js", "--host", "0.0.0.0", "--port", "8081", "--db", "/data/hub.db"]
