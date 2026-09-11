#!/bin/sh
# 容器入口:修正数据卷属主后降权运行应用。
#
# 背景:具名卷若由「以 root 运行」的旧镜像创建,其内容属主为 root。本镜像以
# node(uid 1000)运行应用,直接启动会因无法写 SQLite 库文件而失败:
#   Internal error: attempt to write a readonly database
# Dockerfile 中「在 VOLUME 声明前 chown /data」只对**全新空卷**生效——Docker 仅在
# 首次创建具名卷时复制镜像目录的属主,已存在的卷不会被重新 chown。升级场景因此
# 需要在此自愈。
#
# 安全说明:容器以 root 启动仅用于这一次 chown,随后立即用 su-exec 降权到 node
# 执行应用;应用进程始终是非 root。这是 postgres/redis 等官方镜像的通行做法。
set -e

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  # 目录很小(仅库文件与 WAL),全量 chown 开销可忽略;幂等,重复启动无副作用。
  chown -R node:node /data
  exec su-exec node "$@"
fi

# 已被显式指定非 root 用户(--user node)时不再改属主,直接运行
exec "$@"
