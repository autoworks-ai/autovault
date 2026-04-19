# AutoVault is an MCP stdio server. The container is a build/distribution
# artifact, not a long-running network service. An MCP host (e.g. Cursor,
# Claude Desktop, or a custom client) is expected to spawn `node dist/index.js`
# over stdio. This image does NOT expose any network port.

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
VOLUME ["/data"]
ENV AUTOVAULT_STORAGE_PATH=/data/autovault

CMD ["node", "dist/index.js"]
