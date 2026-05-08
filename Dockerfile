# Remote AutoVault service image. Local MCP hosts can still spawn
# `node dist/index.js` over stdio; this container defaults to the Streamable
# HTTP MCP server at /mcp for Docker/Railway style deployments.

FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm pkg delete scripts.prepare && npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY skills ./skills
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm pkg delete scripts.prepare && npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY scripts ./scripts
COPY skills ./skills
VOLUME ["/data/autovault"]
ENV AUTOVAULT_STORAGE_PATH=/data/autovault
ENV AUTOVAULT_MODE=remote
ENV AUTOVAULT_HTTP_PORT=3000
EXPOSE 3000

CMD ["node", "dist/remote.js"]
