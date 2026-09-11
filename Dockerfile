# ── 阶段 1:构建管理控制台前端产物(Vue 3 + Naive UI) ─────────────────────────
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npx vite build

# ── 阶段 2:构建网关服务端(Node 版,运行镜像最小化) ───────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx esbuild src/server.ts --bundle --platform=node --format=cjs --outfile=dist/server.cjs

# ── 阶段 3:运行镜像(仅服务端产物 + 前端静态文件,无 node_modules) ─────────────
FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./public
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_FILE=/data/codebuddy.db \
    PUBLIC_DIR=/app/public
VOLUME ["/data"]
EXPOSE 8787
CMD ["node", "dist/server.cjs"]
