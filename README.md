# CodeBuddy Proxy — Cloudflare Worker

**Cloudflare Workers** 项目，部署在边缘网络，零服务器成本、全球低延迟。

## ✨ 功能特性

- **透明代理转发** — 转发 `/v1/chat/completions` 到 CodeBuddy 上游 API
- **系统提示词改写** — 将 Anthropic/Claude Code 相关文字替换为 CodeBuddy（保持客户端无感知）
- **流式 SSE 透传** — 原样透传上游 SSE 流式响应
- **非流式聚合** — 当客户端请求非流式（`stream=false`）时，自动聚合上游 SSE 分片为标准 `chat.completion` 响应
- **模型 ID 规范化** — 自动剥离模型名后缀（如 `model[1m]` → `model`）
- **OpenAI 兼容模型列表** — 内置模型数据，提供 `/v1/models` 接口
- **额度查询代理** — 透传 `/quota` 积分查询，自动转发 `Authorization`
- **CORS 跨域支持** — 可配置允许来源与凭证
- **可配置超时** — 总超时与连接超时分离控制
- **调试日志** — 开启后输出请求/响应详情（敏感头自动脱敏）

## 📁 项目结构

```
cloudflare-proxy/
├── src/
│   ├── index.ts     # Worker 入口：路由、CORS、代理转发、SSE 聚合
│   ├── models.ts    # 内置模型数据（OpenAI 兼容格式）
│   └── utils.ts     # 环境变量、系统提示词改写、调试与响应工具
├── tests/
│   └── run-tests.mjs  # 单元测试（esbuild 打包后用 Node 原生 assert）
├── wrangler.jsonc   # Wrangler 配置与环境变量
├── package.json
└── tsconfig.json
```

## 🚀 快速开始

```bash
# 安装依赖
npm install

# 本地开发（Wrangler 本地运行时）
npm run dev

# 部署到 Cloudflare
npm run deploy

# 运行测试
npm test

# 类型检查
npm run typecheck
```

## ⚙️ 环境变量

在 `wrangler.jsonc` 的 `vars` 字段或 Cloudflare Dashboard「变量」页面配置：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `UPSTREAM_CHAT_COMPLETIONS_URL` | `https://copilot.tencent.com/v2/chat/completions` | Chat Completions 上游 API 地址 |
| `UPSTREAM_QUOTA_URL` | `https://copilot.tencent.com/v2/billing/meter/get-user-resource` | 积分/额度查询上游 API 地址 |
| `UPSTREAM_TIMEOUT_SECONDS` | `600` | 总超时（秒） |
| `UPSTREAM_CONNECT_TIMEOUT_SECONDS` | `30` | 连接超时（秒） |
| `CORS_ALLOW_ORIGINS` | `*` | 允许的跨域来源，逗号分隔多个 |
| `CORS_ALLOW_CREDENTIALS` | `false` | 是否允许携带凭证（`true`/`false`） |
| `DEBUG` | `false` | 是否开启调试日志（`1`/`true`/`yes`/`on` 均视为开启） |

> 💡 Worker 总超时 = `UPSTREAM_TIMEOUT_SECONDS` + `UPSTREAM_CONNECT_TIMEOUT_SECONDS`，超时后返回 `504`。

## 📡 API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/v1/chat/completions` | Chat Completions 代理（支持流式/非流式） |
| `GET` | `/v1/models` | OpenAI 兼容模型列表 |
| `GET` | `/v1/models/:id` | 单个模型详情 |
| `POST` | `/quota` | 积分/额度查询代理，透传 `Authorization` |
| `GET` | `/` 或 `/health` | 健康检查 |
| `OPTIONS` | `*` | CORS 预检 |

### 流式与非流式处理

- **流式请求**（`stream: true`）：直接透传上游 SSE 流，保留 `text/event-stream`。
- **非流式请求**（`stream: false` 或未指定）：上游始终以流式返回，Worker 在内部聚合所有 SSE 分片，按 `choice.index` 合并 `delta`（`content`/`reasoning_content`/`tool_calls`），最终组装成标准 `chat.completion` 响应。

> ⚠️ 当上游返回非 2xx 时，即使是非流式请求也会原样透传错误响应，便于客户端排查。

### 系统提示词改写规则

代理会改写 `role` 为 `system` 或 `developer` 的消息内容（支持纯字符串和 `content` 数组两种格式）：

| 原文（匹配） | 替换为 |
|------|------|
| `You are Claude Code, Anthropic's official CLI for Claude.` | `You are CodeBuddy, Tencent's official CLI.` |
| `main branch (you will usually use this for prs)` | `main branch (you will usually use this for pr)` |

## 🧪 测试

```bash
npm test
```

测试通过 `esbuild` 将 TypeScript 源码打包为 ESM，再用 Node 原生 `assert` 执行，覆盖：

- 系统提示词改写（`rewritePayload`）
- 模型 ID 规范化（`normalizeModelId`）
- CORS 头构建（`buildCorsHeaders`）
- 上游 URL 构建（`buildUpstreamUrl`）
- Worker 路由分发与响应

## ☁️ 部署

### 方式一：Wrangler CLI

```bash
# 直接部署（使用 wrangler.jsonc 默认配置）
npx wrangler deploy

# 指定环境
npx wrangler deploy --env production
```

### 方式二：Cloudflare Dashboard

1. 在 Cloudflare Dashboard 创建 Worker
2. 将 `src/index.ts`、`src/utils.ts`、`src/models.ts` 内容粘贴进去
3. 在「变量」页面配置上文表格中的同名环境变量
4. 保存并部署

> 📊 项目已开启 `observability`，可在 Cloudflare Dashboard 查看请求日志与调试输出。

## 🔒 安全说明

- 代理转发时自动剥离逐跳头（hop-by-hop headers），避免连接复用问题
- 调试日志会对 `authorization`、`cookie` 等敏感头脱敏后再输出
- CORS 凭证模式（`CORS_ALLOW_CREDENTIALS`）默认关闭，按需开启
