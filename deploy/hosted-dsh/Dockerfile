ARG NODE_VERSION=24-bookworm-slim
FROM node:${NODE_VERSION}

ARG DSH_VERSION=0.1.0-rc.7

ENV DSH_HOME=/dsh-home \
    DSH_HUB_PROFILE=web \
    DSH_WEB_PORT=3080 \
    DSH_HUB_PLUGIN_SOURCE=/opt/dsh-hub/packages/dsh-hub-plugin \
    DSH_HUB_PLUGIN_CONFIG_DIR=/dsh-home/dsh-hub-plugin

WORKDIR /opt/dsh-hub

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    git \
    make \
    g++ \
    python3 \
    tini \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/dsh-hub-service/package.json packages/dsh-hub-service/package.json
COPY packages/dsh-hub-client/package.json packages/dsh-hub-client/package.json
COPY packages/dsh-hub-plugin/package.json packages/dsh-hub-plugin/package.json

RUN npm ci --include=dev \
  && npm install --global "@deepseek-ai/dsh@${DSH_VERSION}" \
  && npm cache clean --force

COPY packages ./packages
COPY deploy/hosted-dsh/entrypoint.sh /usr/local/bin/dsh-hub-hosted-entrypoint

RUN ln -sf /opt/dsh-hub/packages/dsh-hub-client/bin/dsh-hub-client.js /usr/local/bin/dsh-hub-client \
  && ln -sf /opt/dsh-hub/packages/dsh-hub-client/bin/dsh-hub-web.js /usr/local/bin/dsh-hub-web \
  && ln -sf /opt/dsh-hub/packages/dsh-hub-plugin /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/dsh-hub-plugin \
  && rm -f /usr/local/bin/dsh \
  && { \
    echo '#!/usr/bin/env bash'; \
    echo 'exec node --expose-internals /usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"'; \
  } > /usr/local/bin/dsh \
  && useradd --system --uid 10001 --gid node --create-home --home-dir /home/dsh dsh \
  && mkdir -p /dsh-home /workspace /logs \
  && chown -R dsh:node /opt/dsh-hub /dsh-home /workspace /logs /home/dsh \
  && chmod 0755 /usr/local/bin/dsh /usr/local/bin/dsh-hub-hosted-entrypoint

USER dsh
WORKDIR /workspace

EXPOSE 3080
ENTRYPOINT ["tini", "--", "/usr/local/bin/dsh-hub-hosted-entrypoint"]
CMD ["start"]
