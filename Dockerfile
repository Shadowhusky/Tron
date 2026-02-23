# ---- Build stage ----
FROM node:22-bookworm AS build

WORKDIR /app

# Install build tools for native modules (node-pty, cpu-features)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:web

# ---- Production stage ----
FROM node:22-bookworm-slim

WORKDIR /app

# node-pty needs these at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    procps \
    bash \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy built assets from build stage
COPY --from=build /app/dist-react ./dist-react
COPY --from=build /app/dist-server ./dist-server

EXPOSE 3888

# Default to local mode (full terminal access inside container)
ENV NODE_ENV=production

CMD ["node", "dist-server/index.js"]
