# ---- Build stage ----
FROM node:22-bookworm AS build

WORKDIR /app

# Install build tools for native modules (node-pty, cpu-features)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:web

# Prune devDependencies so we can copy node_modules directly
RUN npm prune --omit=dev

# ---- Production stage ----
FROM node:22-bookworm-slim

WORKDIR /app

# Runtime deps: procps for ps, common tools for terminal use
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    bash \
    curl \
    git \
    vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# Copy pre-built node_modules (native modules already compiled)
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Copy built assets
COPY --from=build /app/dist-react ./dist-react
COPY --from=build /app/dist-server ./dist-server

EXPOSE 3888

ENV NODE_ENV=production
ENV SHELL=/bin/bash

CMD ["node", "dist-server/index.js"]
