# CodeBuddy Gateway

Node.js 反向代理网关：把 OpenAI / Anthropic / Responses 协议转成 CodeBuddy 上游，自带凭证托管与管理台。推荐用 **Docker Compose** 部署到 VPS。

## 功能

- **透明代理转发** — 转发 `/v1/chat/completions` 到 CodeBuddy 上游 API
- **系统提示词改写** — 将 Anthropic/Claude Code 相关文字替换为 CodeBuddy（保持客户端无感知）
- **流式 SSE 透传** — 原样透传上游 SSE 流式响应
- **非流式聚合** — 当客户端请求非流式（`stream=false`）时，自动聚合上游 SSE 分片为标准 `chat.completion` 响应
- **模型 ID 规范化** — 自动剥离模型名后缀（如 `model[1m]` → `model`）
- **模型目录实时同步** — 透传客户端凭证实时拉取上游目录，失败自动回退内置快照
- **三类客户端凭证** — 网关自建 Key（自动刷新）、`ck_` 控制台 Key、CLI accessToken 透传
- **凭证自动刷新** — 托管 CLI OAuth 凭证，临近过期自动换取新 token 并故障转移
- **多协议兼容** — OpenAI Chat Completions / **Anthropic Messages** / **OpenAI Responses** 三协议
- **管理控制台** — Vue 3 + Naive UI 单页应用：实时监控、凭证池运维、客户端 Key、流式试跑、日志、运行配置
- **Key 级模型别名** — 客户端模型名 → 上游模型名，客户端零改动
- **SSE 心跳保活** — 长静默思考流防中间层掐断，空流自动兜底 502
- **流式试跑** — 控制台内选凭证/模型逐字对话，含思考过程、耗时与 token 用量，可随时中止
- **实时监控与日志** — 60 分钟流量时序、延迟分位、token 消耗（输入/输出/速率）、按模型/接口聚合、近期错误；运行日志支持级别/关键词过滤与导出
- **控制台体验** — 深色优先可切换、`Ctrl/Cmd + K` 命令面板、hash 深链、自动刷新（切后台自动暂停）
- **额度查询代理** — 透传 `/quota` 积分查询，自动转发 `Authorization`
- **每日签到（Buddy 加油站）** — 按期活动（如第 8 期「开学季」），每日 100 credits；控制台可查期次/连续天数/本期累计/剩余天数，无领取权限的凭证会明确提示而非静默失败
- **CORS 跨域支持** — 可配置允许来源与凭证
- **可配置超时** — 总超时与连接超时分离控制
- **调试日志** — 开启后输出请求/响应详情（敏感头自动脱敏）

## 项目结构

```
gateway/
├── src/                  # 网关服务端（Node）
│   ├── server.ts         # Node HTTP 入口：监听、环境组装、每日签到定时器
│   ├── index.ts          # 请求处理器：路由、CORS、代理转发、SSE 聚合
│   ├── models.ts         # 内置模型快照 + 实时目录拉取
│   ├── protocol/         # 多协议适配:anthropic.ts / responses.ts / sse.ts
│   ├── credentials.ts    # 凭证解析、自动刷新、冷却与故障转移
│   ├── store.ts          # 凭证存储（SQLite / JSON / 内存降级）
│   ├── node-kv.ts        # SQLite / JSON 文件后端
│   ├── crypto.ts         # 哈希、AES-GCM 加密、HMAC 会话签名
│   ├── admin.ts          # 管理鉴权、/admin/api/* 路由与控制台静态托管
│   ├── admin-ui.ts       # 服务端渲染页面（登录页 / 落地页 / 模型目录 / 健康页）
│   ├── static.ts         # 控制台前端产物托管（缓存头 + 目录穿越防护）
│   ├── payload.ts        # 上游载荷处理（代理链路与试跑共用：清洗 + 思考档位映射）
│   ├── metrics.ts        # 进程内请求监控统计（60 分钟滚动窗口）
│   ├── logs.ts           # 进程内运行日志缓冲（供控制台日志页）
│   ├── types.ts          # 凭证体系类型定义
│   ├── utils.ts          # 环境变量、系统提示词改写、响应工具
│   └── rate-limiter.ts   # 内存令牌桶限流
├── web/                  # 管理控制台前端（Vue 3 + Naive UI + Vite）
│   ├── src/views/        # 总览 / 上游凭证 / API Keys / 试跑 / 日志 / 设置
│   ├── src/components/   # 图表、命令面板、状态卡等复用组件
│   ├── src/router.ts     # hash 路由（支持深链）
│   ├── src/autoRefresh.ts# 统一自动刷新调度（页面隐藏时暂停）
│   ├── src/api.ts        # 管理 API 客户端（401 回登录、429 退避）
│   └── vite.config.ts    # base=/admin/，产物由网关托管
├── tests/
│   └── run-tests.mjs  # 单元测试（esbuild 打包后用 Node 原生 assert）
├── Dockerfile            # 三段构建：前端产物 → 服务端 bundle → 精简运行镜像
├── docker-entrypoint.sh  # 入口：修正数据卷属主后降权到 node 运行（升级自愈）
├── docker-compose.yml         # 默认拉取 ghcr.io 预构建镜像
├── docker-compose.build.yml   # 可选覆盖层：从源码本地构建
├── .github/workflows/    # 打 tag 自动构建多架构镜像并推送 ghcr.io
├── package.json
└── tsconfig.json
```

## 管理控制台

控制台是独立的 Vue 3 + Naive UI 单页应用（`web/`），产物由网关进程在 `/admin` 下托管：
静态资源带内容哈希并长缓存，入口文件 `no-store`，未匹配路径回退 SPA 入口，`Ctrl/Cmd + K` 唤起命令面板。

信息架构按运维动线分为四组：

| 视图 | 回答的问题 | 关键交互 |
|---|---|---|
| **总览**（观测） | 服务好不好、流量什么样、哪里出错 | 健康横幅、KPI（成功率 / 平均耗时 / P50 / P95 / Token 消耗 / Token 速率）、60 分钟流量图（悬停十字线读数）、按模型/接口分布（含 token）、近期错误 |
| **上游凭证**（资源） | 凭证池是否可用、额度还剩多少 | 状态摘要 chips 即过滤器、批量测试/启停、额度抽屉（进度条 + 周期）、行内更多菜单、每日自动签到开关 |
| **API Keys**（资源） | 客户端密钥与绑定关系 | 创建后一次性明文（复制 / 下载 .env 接入片段）、绑定勾选、别名表格化编辑 |
| **试跑**（调试） | 这条链路的真实表现 | **真流式**逐字输出、思考过程折叠区、多轮对话、耗时与 token 用量、随时中止 |
| **日志**（调试） | 到底发生了什么 | 级别多选 + 关键词过滤、暂停/恢复（后台继续累积）、导出 JSON、结构化字段展示 |
| **设置**（系统） | 当前部署按什么参数在跑 | 客户端接入地址（一键复制）、上游地址、限流/超时/思考策略、会话与安全说明 |

界面细节：深色优先（`prefers-color-scheme: light` 为例外，可在顶栏切换并记住选择）、自动刷新每 10 秒且页面切后台自动暂停、可见的键盘焦点、`prefers-reduced-motion` 下关闭动效。

监控与日志均为**进程内**数据：不落盘、不记录请求正文或凭证明文，进程重启即清零；需要长期留存请以 `docker logs` 为准。

### Token 消耗统计

token 用量来自**上游返回的 `usage`**（不自行分词估算），三条链路都会采集：

| 链路 | 采集方式 |
|---|---|
| 非流式请求 | 聚合上游 SSE 时顺带解析（整条响应已在内存中，零额外成本） |
| 流式请求 | 旁路 `TransformStream` 观察字节流，先转发再解析；usage 在流末尾，响应结束后回填 |
| Anthropic / Responses | 旁路挂在协议转换**之前**（转换后的目标协议事件不再保留上游 usage） |

统计口径：`总览` 的 KPI 展示累计 token、输入/输出拆分与每分钟速率；按模型分布同时给出 token 合计；最近请求明细带单次 token。

**覆盖率说明**：只有上游上报了 `usage` 的请求才计入 token 汇总，KPI 上会显示 `已上报/总请求`，避免把「缺失用量」误读成「没有消耗」。上游未返回 usage 时该请求不计入 token，但请求数照常累计。

### 前端开发

```bash
cd web
npm install
npm run dev      # Vite 开发服务器（HMR），需自行把 /admin/api 代理到网关
npm run build    # 输出 web/dist，网关直接托管
```

设计系统记录在 `design-system/codebuddy-gateway/MASTER.md`（配色、字体、密度与动效基线）。

## 快速开始

### Docker 一键部署（推荐,无需源码）

预构建镜像发布在 GitHub Container Registry,支持 `linux/amd64` 与 `linux/arm64`：

```bash
# 1. 生成三个强随机密钥
openssl rand -hex 32   # → ADMIN_PASSWORD
openssl rand -hex 32   # → ADMIN_SESSION_SECRET
openssl rand -hex 32   # → CREDENTIALS_ENC_SECRET

# 2. 直接运行(把上面三个值填进去)
docker run -d --name codebuddy-gateway \
  --restart unless-stopped \
  -p 8787:8787 \
  -e ADMIN_PASSWORD=<第一个密钥> \
  -e ADMIN_SESSION_SECRET=<第二个密钥> \
  -e CREDENTIALS_ENC_SECRET=<第三个密钥> \
  -v codebuddy-gateway-data:/data \
  ghcr.io/zhi-java/codebuddy2api:latest
```

打开 `http://<你的IP>:8787/admin` 即可进入控制台。

> 三个密钥**必须自行设置且保持稳定**:`ADMIN_PASSWORD` 是控制台登录密码,
> `ADMIN_SESSION_SECRET` 用于会话签名,`CREDENTIALS_ENC_SECRET` 用于加密落盘的上游凭证。
> 后两者一旦变更,已保存的登录态与凭证将全部失效,需重新录入。

> **通过明文 HTTP 访问控制台时**:会话 cookie 是否带 `Secure` 会按请求协议自动判断
> ——HTTPS(或 `X-Forwarded-Proto: https`)带,明文 HTTP 不带。若你的浏览器仍无法
> 保持登录态,可用 `ADMIN_COOKIE_SECURE=false` 显式关闭(反向代理终结 TLS 但未传
> 协议头时需设为 `true`)。

### Docker Compose

需要版本锁定或自定义配置时用 compose。仓库内 `docker-compose.yml` 已指向预构建镜像：

```bash
# 1. 从模板生成本地配置
cp .env.example .env

# 2. 编辑 .env,把三个 CHANGE_ME 换成上一步生成的强随机值

# 3. 拉取并启动(不构建)
docker compose up -d

# 4. 查看日志
docker compose logs -f
```

- 数据卷 `gateway-data` 持久化到 `/data/codebuddy.db`(SQLite),重启不丢
- 每日自动签到由进程内定时器执行(UTC 03:17);未签成功的按 10/30/60/120 分钟递增补签,避免断签
- 更新镜像:`docker compose pull && docker compose up -d`
  - 旧版镜像(以 root 运行)创建的卷属主为 root,新版以 `node` 运行时无法写库。
    容器入口会在启动时自动修正 `/data` 属主后再降权运行,无需手工 `chown`
- 锁定版本:在 `.env` 中设置 `GATEWAY_VERSION=1.0.0`(默认 `latest`)

#### 从源码本地构建

改动源码后需要自编译时,叠加构建覆盖层：

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

#### 多架构说明

发布镜像同时提供 amd64 与 arm64,Docker 会自动选择匹配的架构。
若在 arm64 机器上拉到了 amd64 镜像(旧版 Docker 未启用 Buildx),可显式指定：

```bash
docker pull --platform linux/arm64 ghcr.io/zhi-java/codebuddy2api:latest
```

### 裸 Node

```bash
npm install
npm run build:web    # 构建控制台前端（首次必需，否则 /admin 提示未构建）
npm run build        # → dist/server.cjs
npm start            # 默认 http://0.0.0.0:8787

# 或用 PM2
DATA_FILE=/data/codebuddy.db ADMIN_PASSWORD=xxx ADMIN_SESSION_SECRET=yyy CREDENTIALS_ENC_SECRET=zzz pm2 start dist/server.cjs --name codebuddy-gateway
pm2 save && pm2 startup
```

```bash
# 运行测试
npm test

# 类型检查
npm run typecheck
```

> 要求 Node ≥ 22.13(内置 SQLite)。旧 Node 自动降级 JSON 文件存储。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听地址 |
| `DATA_FILE` | `./data/codebuddy.db` | SQLite 路径(`.json` 结尾则用 JSON 文件) |
| `UPSTREAM_CHAT_COMPLETIONS_URL` | `https://copilot.tencent.com/v2/chat/completions` | Chat Completions 上游 API 地址 |
| `UPSTREAM_QUOTA_URL` | `https://copilot.tencent.com/v2/billing/meter/get-user-resource` | 积分/额度查询上游 API 地址 |
| `UPSTREAM_CONFIG_URL` | `https://copilot.tencent.com/v3/config` | 模型配置（目录）上游 API 地址 |
| `UPSTREAM_REFRESH_URL` | `https://copilot.tencent.com/v2/plugin/auth/token/refresh` | token 刷新上游 API 地址 |
| `GATEWAY_KEY_PREFIX` | `sk-cb` | 网关自建 Key 前缀 |
| `UPSTREAM_TIMEOUT_SECONDS` | `600` | 总超时（秒） |
| `UPSTREAM_CONNECT_TIMEOUT_SECONDS` | `30` | 连接超时（秒） |
| `CORS_ALLOW_ORIGINS` | `*` | 允许的跨域来源，逗号分隔多个 |
| `CORS_ALLOW_CREDENTIALS` | `false` | 是否允许携带凭证（`true`/`false`） |
| `RATE_LIMIT_PER_MINUTE` | `600` | 入口限流速率（按来源 IP，每分钟） |
| `RATE_LIMIT_BURST` | `60` | 入口限流突发额度（令牌桶容量） |
| `EMIT_THINKING` | 按客户端 | `auto` / `thinking` / `text` / `off`(思考输出策略) |
| `DEBUG` | `false` | 是否开启调试日志（`1`/`true`/`yes`/`on` 均视为开启） |
| `GATEWAY_VERSION` | `latest` | compose 拉取的镜像版本标签（仅影响 compose,非进程内变量） |
| `ADMIN_PASSWORD` | — | 管理界面密码。**未设置时 `/admin` 返回 404** |
| `ADMIN_SESSION_SECRET` | — | 会话 cookie 的 HMAC 签名密钥 |
| `CREDENTIALS_ENC_SECRET` | — | 凭证落盘 AES-GCM 加密密钥 |

> 上游总超时 = `UPSTREAM_TIMEOUT_SECONDS` + `UPSTREAM_CONNECT_TIMEOUT_SECONDS`，超时后返回 `504`。

## 客户端凭证体系

网关支持三类客户端凭证，按 `Authorization: Bearer <token>` 传入：

| 类型 | 形态 | 行为 |
|------|------|------|
| **网关自建 Key**（推荐） | `sk-cb-xxx` | 网关托管上游凭证，**自动刷新**、多凭证故障转移 |
| 控制台 API Key | `ck_xxx` | 原样透传上游 |
| CLI accessToken | JWT | 原样透传上游 |

网关 Key 的优势：客户端配置一次即可，**不再受 CLI accessToken 60 天过期影响**——过期前 10 分钟网关自动用 refreshToken 换新，失败则冷却该凭证并切换到绑定集内的其他健康凭证。

### 多凭证高可用策略

客户端 Key 绑定多个上游凭证时，网关按健康状态选择凭证，并在请求尚未开始向客户端输出前执行故障转移：

- 上游返回 `401/403/408/425/429/5xx`：记录该凭证失败并冷却，自动尝试绑定集中的下一个凭证。
- 上游返回 `400` 且响应体为空：视为渠道级异常，也会自动切换；有明确错误体的 `400` 不盲目重试，避免重复发送本身无效的请求。
- 流式响应已经开始后不会重放，避免客户端收到重复内容。
- 所有候选凭证都失败后，返回最后一次上游错误；失败事件会写入 Docker 日志，包含请求 ID、状态、凭证 ID 和是否空响应，不记录 token 或请求正文。

因此，多个 Key 可以覆盖凭证过期、单账号限流、单账号 403 和短暂上游异常；它不能修复所有账号都共同触发的上下文超限或非法参数错误。

### 快速开始

1. 启动服务并配置密钥（见上文）
2. 浏览器打开 `http://<host>:8787/admin`，用 `ADMIN_PASSWORD` 登录
3. 在「上游凭证」添加 `ck_` Key 或 CLI 的 accessToken/refreshToken
4. 在「客户端 API Key」创建 Key 并绑定凭证，**明文仅显示一次**
5. 客户端使用 `Authorization: Bearer sk-cb-xxx` 调用 `/v1/chat/completions`

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/v1/chat/completions` | Chat Completions 代理（支持流式/非流式） |
| `POST` | `/chat/completions` | 同上（DeepSeek Harness / 部分 OpenAI SDK 无 `/v1` 前缀） |
| `POST` | `/v1/messages` | **Anthropic Messages API** 兼容（Claude Code 等客户端） |
| `POST` | `/v1/responses` | **OpenAI Responses API** 兼容（Agent SDK / 新客户端） |
| `GET` | `/v1/models` | 模型列表（实时拉取+快照回退；浏览器访问返回目录页，API 返回 JSON） |
| `GET` | `/models` | 同上（无 `/v1` 前缀） |
| `GET` | `/v1/models/:id` | 单个模型详情 |
| `POST` | `/quota` | 积分/额度查询代理 |
| `GET` | `/admin` | 管理界面（未登录显示登录页） |
| `POST` | `/admin/login` / `/admin/logout` | 管理员登录 / 登出 |
| `GET` | `/admin/api/state` | 仪表盘聚合数据 |
| `*CRUD*` | `/admin/api/credentials[/:id]` | 上游凭证管理 |
| `POST` | `/admin/api/credentials/:id/refresh` | 强制刷新凭证 |
| `*CRUD*` | `/admin/api/keys[/:id]` | 客户端 Key 管理 |
| `POST` | `/admin/api/keys/:id/bind` | 绑定 / 解绑凭证 |
| `POST` | `/admin/api/test` | 凭证连通性自测 |
| `POST` | `/admin/api/chat-test` | Chat 试跑（聚合对话，返回文本/推理/用量） |
| `GET` | `/admin/api/credentials/:id/quota` | 凭证额度查询 |
| `GET` | `/admin/api/credentials/:id/checkin-status` | 签到活动状态（只读：期次 / 连续天数 / 本期累计 / 剩余天数 / 领取权限） |
| `POST` | `/admin/api/credentials/:id/checkin` | 每日签到领取 credits（手动，100 credits/天） |
| `GET/PUT` | `/admin/api/settings` | 网关设置（自动签到开关） |
| `GET` | `/admin/api/config` | 运行配置（只读，不含密钥） |
| `GET` | `/admin/api/metrics` | 实时监控统计（流量时序、延迟分位、按模型/接口聚合） |
| `GET` | `/admin/api/logs` | 运行日志（支持 `level` / `q` / `limit`） |
| `POST` | `/admin/api/chat-test/stream` | 流式试跑（SSE：reasoning / content / usage / done 事件） |
| ⏰ | 进程内定时器 UTC 03:17 | 每日自动签到（需在设置开启）；未签成功的按 10/30/60/120 分钟递增补签 |
| `GET` | `/` | 品牌落地页（网关介绍 / 协议入口 / 管理导航，无鉴权） |
| `GET` | `/health` | 健康检查（浏览器访问返回状态页，监控仍取 JSON） |
| `OPTIONS` | `*` | CORS 预检 |

> 管理接口需登录后访问；未配置 `ADMIN_PASSWORD` 时 `/admin` 返回 404。

### 模型目录同步

`GET /v1/models` 与 `GET /v1/models/:id` 会**透传客户端 `Authorization`** 向上游 `UPSTREAM_CONFIG_URL` 实时拉取模型目录，网关自身不持有任何上游凭据。

处理顺序：

1. 请求携带 `Authorization: Bearer <token>` → 透传并补齐上游要求的固定身份头（UA / X-IDE / X-User-Id）
2. `X-User-Id` 优先取客户端 JWT 的 `sub`，解析不到时用随机 UUID（模型目录与身份无关）
3. 上游返回有效目录 → 返回动态结果，并按凭证指纹缓存 **10 分钟**
4. 无凭证、上游失败、超时、返回空 → **自动回退内置静态快照**，接口始终 200

> 客户端凭证失效不会导致 `/v1/models` 报错，只会退化为静态快照。

### 流式与非流式处理

- **流式请求**（`stream: true`）：直接透传上游 SSE 流，保留 `text/event-stream`。
- **非流式请求**（`stream: false` 或未指定）：上游始终以流式返回，网关在内部聚合所有 SSE 分片，按 `choice.index` 合并 `delta`（`content`/`reasoning_content`/`tool_calls`），最终组装成标准 `chat.completion` 响应。

> 当上游返回非 2xx 时，即使是非流式请求也会原样透传错误响应，便于客户端排查。

### 上游渠道兼容（重要）

CodeBuddy 上游会校验请求渠道身份，判定为“未授权渠道”时返回：

```text
{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
```

网关在转发前统一做三项规范化，客户端无需任何额外配置：

1. **请求头白名单**：只转发 `accept` / `accept-language` / `content-type`，客户端身份指纹（DSH 的 `deepseek-harness` User-Agent、OpenAI SDK 的 `x-stainless-*`、浏览器的 `origin` / `referer` 等）不会泄漏到上游。
2. **统一 CLI 渠道指纹**：固定发送 `user-agent: CLI/2.107.0 CodeBuddy/2.107.0` 及 `x-ide-type/x-ide-name/x-ide-version/x-requested-with/x-codebuddy-request/x-product/x-private-data`。
3. **`developer` 角色归一化**：上游不接受 `developer` 角色（DSH / 新版 SDK 会把 system prompt 放在该角色），统一改写为 `system`。

上游返回失败时，Docker 日志会输出脱敏诊断（请求 ID、上游请求 ID、状态、凭证 ID、是否空响应、上游错误码与错误消息），不记录 Key 或请求正文。

#### 上游错误码速查

| 错误码 | 含义 | 处理 |
|---|---|---|
| `11128` Illegal API invocation from an unapproved channel | 渠道/角色不合规（如传了 `developer` 角色） | 网关已自动规避 |
| `11140` 内容未通过安全审核 | **账号级风控**：该账号的 chat 生成被拦截，任何内容（含「你好」）、任何模型都会命中；额度查询与每日签到不受影响 | 在管理台把该凭证**停用**；多凭证 Key 会自动切换到健康账号 |
| `14018` 额度已用尽 | 该账号套餐额度耗尽 | 停用或购买加量包 |
| `11101` Non-stream chat request is currently not supported | 上游只接受流式 | 网关已强制 `stream: true` |

### 三种协议与思考输出

三种协议都能拿到上游的思考内容，且思考**始终独立于正文**（不会混进 `content`）：

| 协议 | 思考载体 |
|---|---|
| Chat Completions | 流式 `delta.reasoning_content`；非流式 `choices[].message.reasoning_content` |
| Anthropic Messages | `thinking` content block（`thinking_delta`）；非流式 content 里 `type: "thinking"` 块 |
| OpenAI Responses | `reasoning` item 与 `response.reasoning_summary_text.*` 事件；非流式 output 里 `type: "reasoning"` item |

上游各模型开启思考的参数并不一致（例如 `hy4-preview` 默认就输出 reasoning，`deepseek-v4-flash` / `deepseek-v4.1-flash` 必须显式传 `reasoning_effort` 才会输出），因此网关会按模型元数据（内置快照 + 上游实时目录，后者覆盖新增模型）把客户端的思考意图映射成上游需要的 `reasoning_effort`：客户端未指定时补模型默认档位，客户端显式关闭或 `EMIT_THINKING=off` 时不传。

`EMIT_THINKING` 策略：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 思考独立下发，客户端自行决定是否渲染 |
| `thinking` | 同上（显式声明） |
| `text` | 并入正文（仅用于不识别思考块的客户端） |
| `off` | 丢弃思考内容（也不向上游请求思考） |

只有上游模型实际返回 `reasoning_content` 时才会产生思考输出；普通非推理模型不会凭空生成思考内容。

## 性能与高可用

网关是单进程 Node 服务，热路径（鉴权 → 凭证解析 → 转发 → 流式回写）已做过针对性优化，并用本地 mock 上游的基准脚本验证（并发 20、300 次请求）：

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 吞吐 | 63 req/s | 529 req/s |
| 请求延迟 p50 | 313 ms | 36 ms |
| `/health` 探测 p95（事件循环阻塞） | 256 ms | 17 ms |

关键改动：

- **凭证/Key 列表缓存**：代理每请求都要读「绑定凭证」与「Key 记录」，原来每次都会做同步 SQLite 查询 + 逐条 AES-GCM 解密，直接阻塞事件循环；现在按 KV 实例做 2 秒 TTL 缓存，写入即失效。
- **`lastUsedAt` 落盘节流**：原来每个请求同步写一次 SQLite，改为同一 Key 最多每 60 秒落盘一次（「最近使用」精度仍为分钟级）。
- **入口限流可配置且默认放宽**：默认 600 次/分钟、突发 60（按来源 IP）。编码智能体的工具调用循环很容易超过旧的 60 次/分钟，且多个客户端常共用出口 IP。被限流时返回 `Retry-After: 2`。
- **流式回写尊重背压**：客户端读得慢时等待 `drain`，避免响应在内存里无限堆积。

高可用：

- **容器自愈**：`docker-compose.yml` 内置 healthcheck（命中 `/health`），失败时 Docker 自动重建容器（配合 `restart: unless-stopped`）。
- **优雅停机**：`SIGTERM` 后停止接受新连接、排空在途请求（含 SSE 流），最多等待 25 秒；compose 的 `stop_grace_period: 30s` 覆盖该窗口，滚动更新时不会截断流式响应。
- **多副本**：如需零停机更新，可在同一 compose 中起两个实例并用反向代理（Caddy/Nginx/Traffic）做上游切换。注意以下状态是**进程内**的，多副本时各自独立：限流计数、凭证冷却、模型目录缓存、监控统计与日志缓冲。凭证数据本身在共享卷上（SQLite），多副本写入需自行评估（建议仅一个副本写入，或改用支持并发写的存储）。
- **上游连接**：出站使用 Node 内置 fetch（undici）连接池，默认 keep-alive；上游超时由 `UPSTREAM_TIMEOUT_SECONDS` / `UPSTREAM_CONNECT_TIMEOUT_SECONDS` 控制。
- **进程兜底**：上游在响应中途断流时，undici 会把 `TypeError: terminated`（`UND_ERR_SOCKET`）抛到事件循环顶层，默认语义下会直接杀掉进程（所有客户端同时断服）。网关把这类连接层噪音降级为告警日志，只影响该请求；其它未捕获异常仍按默认语义退出并由容器重启策略拉起，不会掩盖真正的逻辑缺陷。

### 多凭证高可用与故障转移
一个客户端 Key 可以绑定多个上游凭证。每次请求会按健康状态选择凭证；如果当前凭证出现以下可切换故障，网关会在响应交给客户端前自动换下一个绑定凭证重试：

- HTTP `401` / `403` / `408` / `425` / `429`
- HTTP `5xx`
- HTTP `400` 且响应体为空（上游渠道指纹异常，换账号可绕过）

失败凭证会进入约 60 秒进程内冷却，并在管理台标记最近错误；冷却期间优先跳过，其他请求继续使用健康凭证。请求成功后会清除此前的错误状态。客户端无需重试即可获得透明故障转移。

上下文超限、参数错误等 HTTP `400` 不会切换凭证，因为换 Key 无法修复同一请求；流式响应一旦已经开始输出，也不会中途重放，避免客户端收到重复内容。所有绑定凭证均不可用时，网关返回 `502`。

**只有上游明确返回的响应才会触发故障转移。** 网关自身产生的失败——响应体读取中断、超时、非流式聚合拿到空流——会带内部标记返回 `502`/`504`，**不重放**请求。原因是这类失败发生时上游通常已经生成内容并按量计费，换凭证重发会让同一条 prompt 扣两次积分。代价是这类请求直接失败（客户端可自行重试），收益是积分不会被重复消耗。

### 系统提示词改写规则

代理会改写 `role` 为 `system` 或 `developer` 的消息内容（支持纯字符串和 `content` 数组两种格式）：

| 原文（匹配） | 替换为 |
|------|------|
| `You are Claude Code, Anthropic's official CLI for Claude.` | `You are CodeBuddy, Tencent's official CLI.` |
| `main branch (you will usually use this for prs)` | `main branch (you will usually use this for pr)` |

## 测试

```bash
npm test
```

测试通过 `esbuild` 将 TypeScript 源码打包为 ESM，再用 Node 原生 `assert` 执行（19 组用例），覆盖：

- 系统提示词改写（`rewritePayload`）与模型 ID 规范化（`normalizeModelId`）
- 网关路由、CORS 头构建与上游 URL 构建
- 实时模型目录拉取、缓存与失败回退
- 凭证存储 CRUD、Key 哈希、AES-GCM 加解密与列表缓存
- 凭证过期判定、刷新链路、冷却与故障转移
- 三协议适配（Chat Completions / Anthropic Messages / OpenAI Responses）与思考内容输出
- 上游错误透传、空响应回填与凭证级故障转移
- 三协议端点端到端、内容协商与 SPA 入口、控制台静态托管（含目录穿越防护）
- 入口限流、上游计费（额度解析 / 签到状态解析）与自动签到语义
  （含：旧路径恒返回 inactive、`ck_` 控制台 Key 可读不可领、按 JWT 形态而非 kind 判权限）
- 运行时可靠性：SSE 心跳、空流兜底、Key 级模型别名
- 实时监控统计（滚动窗口、延迟分位、按模型/接口聚合）与运行日志缓冲（级别/关键词过滤）
- 管理端新增能力：只读运行配置（不泄漏密钥）与流式试跑事件序列
- 重复计费防护：网关自身失败（读取中断/空流兜底）不触发凭证重放、真实 HTTP 断流端到端不重放、进程级网络异常兜底不吞业务缺陷
- Token 消耗统计：非流式聚合 / 流式旁路 / 协议转换三条采集链路，无 usage 不误计、重复上报不重复累加
- Node 部署端到端（健康检查、登录、管理、SQLite 持久化）

## 镜像发布

镜像发布在 GitHub Container Registry，支持 `linux/amd64` 与 `linux/arm64`：

```
ghcr.io/zhi-java/codebuddy2api:latest
ghcr.io/zhi-java/codebuddy2api:1.0.0
```

发布流程：打版本 tag 并推送，CI 自动构建多架构镜像并推送。

```bash
git tag v1.0.0
git push origin v1.0.0
```

tag 规则：`v1.0.0` → `1.0.0` / `1.0` / `1` / `latest`；预发布版本（如 `v1.0.0-rc.1`）**不覆盖 `latest`**。
在 Actions 页面手动触发 workflow 可验证流水线，但不会推送镜像。

## 安全说明

- **应用进程以非 root 用户（`node`，uid 1000）运行**，缩小容器逃逸后的影响面。
  容器入口以 root 启动仅用于修正数据卷属主（见 `docker-entrypoint.sh`），
  随后立即 `su-exec` 降权，应用进程始终非 root
- 代理转发时自动剥离逐跳头（hop-by-hop headers），避免连接复用问题
- 调试日志会对 `authorization`、`cookie` 等敏感头脱敏后再输出
- CORS 凭证模式（`CORS_ALLOW_CREDENTIALS`）默认关闭，按需开启

### 凭证体系相关

- **客户端 Key 只存哈希**（SHA-256），明文仅在创建时返回一次，管理接口永不回显 token
- **上游凭证加密存储**（AES-GCM，密钥取自 `CREDENTIALS_ENC_SECRET`）
- **管理会话为无状态 HMAC 签名 cookie**，httpOnly + Secure + SameSite=Lax，不占存储
- **写接口校验 Origin 同站**，阻断跨站 CSRF
- **登录接口独立限流**，防止密码爆破
- `/admin` 未配置 `ADMIN_PASSWORD` 时返回 404，不暴露管理面
