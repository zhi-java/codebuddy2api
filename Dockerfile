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

# OCI 镜像元数据:ghcr.io 据此把包关联回源码仓库,并展示许可证与描述
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="CodeBuddy Gateway" \
      org.opencontainers.image.description="OpenAI / Anthropic / Responses 协议转 CodeBuddy 上游的反向代理网关,自带凭证托管与管理控制台" \
      org.opencontainers.image.source="https://github.com/zhi-java/codebuddy2api" \
      org.opencontainers.image.url="https://github.com/zhi-java/codebuddy2api" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

WORKDIR /app

# 以非 root 运行应用:容器逃逸时限制影响面。node 镜像内置 uid=1000 的 node 用户。
# /data 需在 VOLUME 声明前建好并改属主——首次挂载具名卷时 Docker 会复制该目录的
# 权限,从而让 node 用户对卷可写。
# 注意:这只对**全新空卷**生效。若卷由旧版本(以 root 运行)创建,其内容属主是 root,
# Docker 不会重新 chown。该升级场景由 docker-entrypoint.sh 在启动时自愈。
RUN mkdir -p /data && chown -R node:node /data

# su-exec:入口脚本降权用(体积约 10KB,Alpine 官方包)
RUN apk add --no-cache su-exec

COPY --from=build /app/dist ./dist
COPY --from=web /web/dist ./public

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DATA_FILE=/data/codebuddy.db \
    PUBLIC_DIR=/app/public

VOLUME ["/data"]
EXPOSE 8787

# 自带健康检查:用户直接 docker run(不经过 compose)时同样具备自愈依据
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 入口以 root 启动仅用于修正数据卷属主,随即 su-exec 降权到 node 运行应用
# (见 docker-entrypoint.sh)。应用进程始终为非 root。
ENTRYPOINT ["docker-entrypoint.sh"]

CMD ["node", "dist/server.cjs"]
