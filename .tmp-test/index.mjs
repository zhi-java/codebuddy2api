// src/utils.ts
var PROMPT_ROLES = /* @__PURE__ */ new Set(["system", "developer"]);
var SYSTEM_TEXT_REPLACEMENTS = [
  [
    /You\s+are\s+Claude\s+Code,\s*Anthropic['’]s\s+official\s+CLI\s+for\s+Claude\.?/gi,
    "You are CodeBuddy, Tencent's official CLI."
  ],
  [
    /main\s+branch\s+\(you\s+will\s+usually\s+use\s+this\s+for\s+prs\)/gi,
    "main branch (you will usually use this for pr)"
  ]
];
var MODEL_SUFFIX_PATTERN = /^(.+)\[[^\]]+\]$/;
function replaceSystemText(text) {
  let result = text;
  for (const [pattern, replacement] of SYSTEM_TEXT_REPLACEMENTS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
function normalizeModelId(modelId) {
  const trimmed = modelId.trim();
  const match = trimmed.match(MODEL_SUFFIX_PATTERN);
  return match ? match[1].trim() : trimmed;
}
function rewritePayload(payload) {
  if (typeof payload["model"] === "string") {
    payload["model"] = normalizeModelId(payload["model"]);
  }
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return payload;
  for (const message of messages) {
    if (!message || typeof message !== "object" || !PROMPT_ROLES.has(String(message["role"]))) continue;
    const content = message["content"];
    if (typeof content === "string") {
      message["content"] = replaceSystemText(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && part["type"] === "text" && typeof part["text"] === "string") {
          part["text"] = replaceSystemText(part["text"]);
        }
      }
    }
  }
  return payload;
}
async function fetchWithTimeout(env, requestInfo, requestInit = {}) {
  const controller = new AbortController();
  const timeoutMs = parseFloat(env.UPSTREAM_TIMEOUT_SECONDS || "600") * 1e3;
  const connectTimeoutMs = parseFloat(env.UPSTREAM_CONNECT_TIMEOUT_SECONDS || "30") * 1e3;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs + connectTimeoutMs);
  try {
    const response = await fetch(requestInfo, { ...requestInit, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error("Upstream timeout");
    }
    throw err;
  }
}
function jsonResponse(data, env, status = 200) {
  const body = JSON.stringify(data);
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": env.CORS_ALLOW_ORIGINS?.trim() || "*"
  });
  return new Response(body, { status, headers });
}

// src/models.ts
var MODELS_DATA = {
  "code": 0,
  "msg": "OK",
  "requestId": "a93702ad-4405-4372-b085-70588ae66a87",
  "data": {
    "agents": [
      {
        "commands": [
          "init",
          "compact",
          "statusline",
          "insights"
        ],
        "description": "cli agent",
        "instructions": "cli-agent-prompt",
        "modelTags": [
          "craft"
        ],
        "models": [
          "hy4-preview",
          "hy3",
          "hy3-x",
          "glm-5.3",
          "glm-5.3-flash",
          "glm-5.2",
          "glm-5.1",
          "glm-5v-turbo",
          "minimax-m3",
          "minimax-m2.7",
          "kimi-k3-1",
          "kimi-k2.7",
          "kimi-k2.6",
          "deepseek-v4-pro",
          "deepseek-v4-flash"
        ],
        "name": "cli",
        "tags": [
          "cli",
          "default",
          "model:craft"
        ],
        "tools": [
          "Agent",
          "Read",
          "Write",
          "Edit",
          "Bash",
          "PowerShell",
          "Glob",
          "Grep",
          "EnterPlanMode",
          "ExitPlanMode",
          "TaskCreate",
          "TaskGet",
          "TaskUpdate",
          "TaskList",
          "WebFetch",
          "WebSearch",
          "TaskStop",
          "TaskOutput",
          "Skill",
          "SkillManage",
          "AskUserQuestion",
          "StructuredOutput",
          "ToolSearch",
          "DeferExecuteTool",
          "SendMessage",
          "TeamCreate",
          "TeamDelete",
          "NotebookEdit",
          "LSP",
          "ImageGen",
          "EnterWorktree",
          "LeaveWorktree",
          "CronCreate",
          "CronDelete",
          "CronList",
          "DelegateTool",
          "WeChatReply",
          "WeComReply",
          "ComputerUse"
        ]
      }
    ],
    "enterpriseId": "",
    "models": [
      {
        "credits": "x2.00 credits",
        "id": "default",
        "maxAllowedSize": 56e3,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 24e3,
        "name": "Default",
        "supportsImages": false,
        "supportsToolCall": true,
        "vendor": "v"
      },
      {
        "credits": "x0.51 credits",
        "id": "deepseek-v4-pro",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 5e4,
        "name": "Deepseek-V4-Pro",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "deepseek-v4-pro",
          "reasoning": "deepseek-v4-pro"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.17 credits",
        "id": "deepseek-v4-flash",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 5e4,
        "name": "Deepseek-V4-Flash",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "deepseek-v4-flash",
          "reasoning": "deepseek-v4-flash"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.29 credits",
        "disabledMultimodal": true,
        "id": "deepseek-v3-2-volc",
        "maxAllowedSize": 96e3,
        "maxInputTokens": 96e3,
        "maxOutputTokens": 32e3,
        "name": "DeepSeek-V3.2",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "deepseek-v3-2-volc",
          "reasoning": "deepseek-v3-2-volc"
        },
        "supportsImages": false,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.18 credits",
        "id": "minimax-m2.5",
        "maxAllowedSize": 2e5,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 48e3,
        "name": "MiniMax-M2.5",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "supportsImages": false,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.25 credits",
        "descriptionEn": "Native multimodal model for coding and agents tasks",
        "descriptionZh": "\u539F\u751F\u591A\u6A21\u6001\uFF0C\u64C5\u957F\u4EE3\u7801\u3001\u667A\u80FD\u4F53\u4EFB\u52A1",
        "disabledMultimodal": false,
        "id": "minimax-m3",
        "maxAllowedSize": 512e3,
        "maxInputTokens": 512e3,
        "maxOutputTokens": 128e3,
        "name": "MiniMax-M3",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "minimax-m3",
          "reasoning": "minimax-m3"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.19 credits",
        "id": "minimax-m2.7",
        "maxAllowedSize": 2e5,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 48e3,
        "name": "MiniMax-M2.7",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "minimax-m2.7",
          "reasoning": "minimax-m2.7"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.79 credits",
        "id": "glm-5.3",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 48e3,
        "name": "GLM-5.3",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "glm-5.3",
          "reasoning": "glm-5.3"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.06 credits",
        "descriptionEn": "Native multimodal, excelling at complex, long-horizon autonomous tasks.",
        "descriptionZh": "\u539F\u751F\u591A\u6A21\u6001\uFF0C\u64C5\u957F\u5904\u7406\u590D\u6742\u7684\u957F\u7A0B\u81EA\u4E3B\u4EFB\u52A1\u3002",
        "id": "glm-5.3-flash",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 32e3,
        "name": "GLM-5.3-Flash",
        "onlyReasoning": true,
        "reasoning": {
          "canDisableThinking": true,
          "defaultEffort": "high",
          "summary": "auto",
          "supportedEfforts": [
            "low",
            "high",
            "max"
          ]
        },
        "relatedModels": {
          "lite": "glm-5.3-flash",
          "reasoning": "glm-5.3-flash"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.79 credits",
        "id": "glm-5.2",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 48e3,
        "name": "GLM-5.2",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "glm-5.2",
          "reasoning": "glm-5.2"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.79 credits",
        "id": "glm-5.1",
        "maxAllowedSize": 2e5,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 48e3,
        "name": "GLM-5.1",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "glm-5.1",
          "reasoning": "glm-5.1"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.80 credits",
        "disabledMultimodal": true,
        "id": "glm-5.0",
        "maxAllowedSize": 2e5,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 48e3,
        "name": "GLM-5.0",
        "relatedModels": {
          "lite": "glm-5.0",
          "reasoning": "glm-5.0"
        },
        "supportsImages": false,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.95 credits",
        "id": "glm-5.0-turbo",
        "maxAllowedSize": 2e5,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 48e3,
        "name": "GLM-5.0-Turbo",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "glm-5.0-turbo",
          "reasoning": "glm-5.0-turbo"
        },
        "supportsImages": false,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.71 credits",
        "id": "glm-5v-turbo",
        "maxAllowedSize": 2e5,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 64e3,
        "name": "GLM-5v-Turbo",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "glm-5v-turbo",
          "reasoning": "glm-5v-turbo"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.23 credits",
        "disabledMultimodal": true,
        "id": "glm-4.7",
        "maxAllowedSize": 2e5,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 48e3,
        "name": "GLM-4.7",
        "supportsImages": false,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.23 credits",
        "disabledMultimodal": true,
        "id": "glm-4.6",
        "maxAllowedSize": 168e3,
        "maxInputTokens": 168e3,
        "maxOutputTokens": 32e3,
        "name": "GLM-4.6",
        "supportsImages": false,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.11 credits",
        "id": "glm-4.6v",
        "maxAllowedSize": 128e3,
        "maxInputTokens": 128e3,
        "maxOutputTokens": 32e3,
        "name": "GLM-4.6V",
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x1.62 credits",
        "descriptionEn": "Excels at complex, long-horizon autonomous tasks, with standout front-end skills and strong knowledge work and scientific reasoning",
        "descriptionZh": "\u64C5\u957F\u5904\u7406\u590D\u6742\u7684\u957F\u7A0B\u81EA\u4E3B\u4EFB\u52A1\uFF0C\u524D\u7AEF\u5F00\u53D1\u80FD\u529B\u7A81\u51FA\uFF0C\u540C\u65F6\u5728\u77E5\u8BC6\u5DE5\u4F5C\u4E0E\u79D1\u7814\u63A8\u7406\u4E0A\u8868\u73B0\u51FA\u8272\u3002",
        "id": "kimi-k3-1",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 32e3,
        "name": "Kimi-K3",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.57 credits",
        "id": "kimi-k2.7",
        "maxAllowedSize": 256e3,
        "maxInputTokens": 256e3,
        "maxOutputTokens": 32e3,
        "name": "Kimi-K2.7-Code",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "kimi-k2.7",
          "reasoning": "kimi-k2.7"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.52 credits",
        "id": "kimi-k2.6",
        "maxAllowedSize": 256e3,
        "maxInputTokens": 256e3,
        "maxOutputTokens": 32e3,
        "name": "Kimi-K2.6",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "medium",
          "summary": "auto"
        },
        "relatedModels": {
          "lite": "kimi-k2.6",
          "reasoning": "kimi-k2.6"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.45 credits",
        "id": "kimi-k2.5",
        "maxAllowedSize": 164e3,
        "maxInputTokens": 164e3,
        "maxOutputTokens": 32e3,
        "name": "Kimi-K2.5",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.54 credits",
        "id": "kimi-k2-thinking",
        "maxAllowedSize": 164e3,
        "maxInputTokens": 164e3,
        "maxOutputTokens": 32e3,
        "name": "Kimi-K2-Thinking",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "supportsImages": false,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.00 credits",
        "disabledMultimodal": false,
        "id": "hy3",
        "maxAllowedSize": 192e3,
        "maxInputTokens": 192e3,
        "maxOutputTokens": 64e3,
        "name": "Hy3",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 0.9,
        "top_p": 1,
        "vendor": "j"
      },
      {
        "credits": "x0.05 credits",
        "descriptionEn": "Hunyuan's thinking model with enhanced reasoning capabilities",
        "descriptionZh": "\u6DF7\u5143\u601D\u8003\u6A21\u578B\uFF0C\u5177\u6709\u589E\u5F3A\u7684\u63A8\u7406\u80FD\u529B",
        "disabledMultimodal": false,
        "id": "hy3-x",
        "maxAllowedSize": 192e3,
        "maxInputTokens": 192e3,
        "maxOutputTokens": 64e3,
        "name": "Hy3",
        "onlyReasoning": true,
        "reasoning": {
          "effort": "high",
          "summary": "auto"
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 0.9,
        "top_p": 1,
        "vendor": "j"
      },
      {
        "credits": "x0.00 credits",
        "descriptionEn": "Hunyuan's thinking model with enhanced reasoning capabilities",
        "descriptionZh": "\u6DF7\u5143\u601D\u8003\u6A21\u578B\uFF0C\u5177\u6709\u589E\u5F3A\u7684\u63A8\u7406\u80FD\u529B",
        "disabledMultimodal": false,
        "id": "hy4-preview",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 64e3,
        "name": "Hy4 preview",
        "onlyReasoning": true,
        "reasoning": {
          "canDisableThinking": false,
          "defaultEffort": "high",
          "summary": "auto",
          "supportedEfforts": [
            "high"
          ]
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 0.9,
        "top_p": 1,
        "vendor": "j"
      },
      {
        "credits": "x0.29 credits",
        "descriptionEn": "Hunyuan's thinking model with enhanced reasoning capabilities",
        "descriptionZh": "\u6DF7\u5143\u601D\u8003\u6A21\u578B\uFF0C\u5177\u6709\u589E\u5F3A\u7684\u63A8\u7406\u80FD\u529B",
        "disabledMultimodal": false,
        "id": "hy4-preview-x",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 64e3,
        "name": "Hy4 preview",
        "onlyReasoning": true,
        "reasoning": {
          "canDisableThinking": false,
          "defaultEffort": "high",
          "summary": "auto",
          "supportedEfforts": [
            "high"
          ]
        },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 0.9,
        "top_p": 1,
        "vendor": "j"
      },
      {
        "credits": "x0.10 credits",
        "disabledMultimodal": true,
        "id": "hunyuan-chat",
        "maxInputTokens": 2e5,
        "maxOutputTokens": 8192,
        "name": "Hunyuan-Turbos",
        "supportsImages": false,
        "supportsToolCall": true,
        "vendor": "j"
      },
      {
        "credits": "x5.00 credits",
        "id": "hunyuan-image-v3.0-art",
        "name": "Hunyuan-Image-v3.0-art",
        "tags": [
          "text-to-image",
          "image-to-image"
        ]
      }
    ],
    "productFeatures": {
      "CodeAdoptionRate": false,
      "TodoAssistantDelegate": false
    }
  }
};
var EPOCH = 171936e4;
var VENDOR_NAMES = {
  e: "tencent",
  f: "techright",
  j: "hunyuan",
  v: "default"
};
function buildModelList() {
  return MODELS_DATA.data.models.map((m) => ({
    id: m.id,
    object: "model",
    created: EPOCH,
    owned_by: VENDOR_NAMES[m.vendor ?? ""] || m.vendor || "unknown",
    _name: m.name,
    _credits: m.credits,
    _vendor: m.vendor,
    _supportsImages: m.supportsImages,
    _supportsReasoning: m.supportsReasoning,
    _supportsToolCall: m.supportsToolCall,
    _maxInputTokens: m.maxInputTokens,
    _maxOutputTokens: m.maxOutputTokens,
    _descriptionZh: m.descriptionZh,
    _descriptionEn: m.descriptionEn
  }));
}
var MODEL_LIST = buildModelList();
function getModelsList() {
  return { object: "list", data: MODEL_LIST };
}
function getModelById(id) {
  const normalizedId = normalizeModelId(id);
  return MODEL_LIST.find((m) => m.id === normalizedId);
}

// src/rate-limiter.ts
var BUCKETS = /* @__PURE__ */ new Map();
var DEFAULT_RATE = 60;
var DEFAULT_WINDOW_MS = 6e4;
var DEFAULT_BURST = 10;
function checkRateLimit(key, rate = DEFAULT_RATE, windowMs = DEFAULT_WINDOW_MS, burst = DEFAULT_BURST) {
  const now = Date.now();
  let bucket = BUCKETS.get(key);
  if (!bucket) {
    bucket = { tokens: burst, lastRefill: now };
    BUCKETS.set(key, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  const refillTokens = elapsed / windowMs * rate;
  bucket.tokens = Math.min(burst, bucket.tokens + refillTokens);
  bucket.lastRefill = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}
function getRateLimitKey(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return `ip:${cfIp}`;
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0].trim();
    if (firstIp) return `ip:${firstIp}`;
  }
  return "anonymous";
}
var lastCleanup = Date.now();
var CLEANUP_INTERVAL_MS = 3e5;
function maybeCleanupBuckets() {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;
  const staleThreshold = now - 6e5;
  for (const [key, bucket] of BUCKETS) {
    if (bucket.lastRefill < staleThreshold) {
      BUCKETS.delete(key);
    }
  }
}

// src/index.ts
var MAX_BODY_SIZE = 10 * 1024 * 1024;
var HOP_BY_HOP = /* @__PURE__ */ new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);
var REQUEST_EXCLUDED = /* @__PURE__ */ new Set(["host", "content-length", ...HOP_BY_HOP]);
var RESPONSE_EXCLUDED = /* @__PURE__ */ new Set(["content-length", ...HOP_BY_HOP]);
var DEFAULT_UPSTREAM_QUOTA_URL = "https://copilot.tencent.com/v2/billing/meter/get-user-resource";
var index_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const rateLimitKey = getRateLimitKey(request);
    if (!checkRateLimit(rateLimitKey)) {
      return new Response("Too Many Requests", { status: 429 });
    }
    maybeCleanupBuckets();
    if (request.method === "OPTIONS") {
      return handleCorsPreflight(request, env);
    }
    if (request.method === "POST") {
      const contentLength = parseInt(request.headers.get("content-length") || "0");
      if (contentLength > MAX_BODY_SIZE) {
        return new Response("Payload Too Large", { status: 413 });
      }
    }
    if (request.method === "GET" && path === "/v1/models") {
      return jsonResponse(getModelsList(), env);
    }
    const modelDetailMatch = path.match(/^\/v1\/models\/(.+)$/);
    if (request.method === "GET" && modelDetailMatch) {
      const model = getModelById(modelDetailMatch[1]);
      if (!model) {
        return jsonResponse({ error: "Model not found" }, env, 404);
      }
      return jsonResponse(model, env);
    }
    if (request.method === "POST" && path === "/v1/chat/completions") {
      return handleChatCompletions(request, env);
    }
    if (request.method === "POST" && path === "/quota") {
      return handleQuota(request, env);
    }
    if (request.method === "GET" && (path === "/" || path === "/health")) {
      return jsonResponse({ status: "ok" }, env);
    }
    return jsonResponse({ error: "Not Found" }, env, 404);
  }
};
function handleCorsPreflight(request, env) {
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(env, request)
  });
}
function parseCorsOrigins(env) {
  return (env.CORS_ALLOW_ORIGINS || "*").split(",").map((origin) => origin.trim()).filter(Boolean);
}
function resolveCorsAllowOrigin(env, requestOrigin) {
  const allowOrigins = parseCorsOrigins(env);
  const allowsAnyOrigin = allowOrigins.length === 0 || allowOrigins.includes("*");
  const allowsCredentials = env.CORS_ALLOW_CREDENTIALS === "true";
  if (allowsAnyOrigin) {
    return allowsCredentials && requestOrigin ? requestOrigin : "*";
  }
  if (requestOrigin && allowOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }
  return allowOrigins[0];
}
function buildCorsHeaders(env, request) {
  const headers = new Headers();
  const requestOrigin = request?.headers.get("origin") ?? null;
  const allowOrigin = resolveCorsAllowOrigin(env, requestOrigin);
  headers.set("access-control-allow-origin", allowOrigin);
  headers.set("access-control-allow-methods", "POST, GET, OPTIONS");
  headers.set("access-control-allow-headers", "*");
  if (env.CORS_ALLOW_CREDENTIALS === "true") {
    headers.set("access-control-allow-credentials", "true");
  }
  if (allowOrigin !== "*") {
    headers.set("vary", "Origin");
  }
  headers.set("access-control-max-age", "86400");
  return headers;
}
async function handleChatCompletions(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }
  const payloadObject = typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : void 0;
  const clientRequestedStream = payloadObject?.["stream"] === true;
  const upstreamUrl = buildUpstreamUrl(env, request.url);
  const upstreamHeaders = new Headers();
  for (const [name, value] of request.headers) {
    if (!REQUEST_EXCLUDED.has(name.toLowerCase())) {
      upstreamHeaders.set(name, value);
    }
  }
  const bodyStr = payloadObject ? JSON.stringify(prepareChatPayload(payloadObject)) : JSON.stringify(payload);
  try {
    const upstreamResponse = await fetchWithTimeout(env, upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body: bodyStr
    });
    if (clientRequestedStream || !upstreamResponse.ok) {
      return buildUpstreamResponse(upstreamResponse, env, request);
    }
    return buildNonStreamingChatResponse(upstreamResponse, env, request);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg === "Upstream timeout") {
      return new Response("Upstream timeout", { status: 504 });
    }
    return new Response(`Upstream error: ${errMsg}`, { status: 502 });
  }
}
async function handleQuota(request, env) {
  const upstreamUrl = env.UPSTREAM_QUOTA_URL || DEFAULT_UPSTREAM_QUOTA_URL;
  const authorization = request.headers.get("authorization");
  const upstreamHeaders = new Headers({
    "content-type": "application/json"
  });
  if (authorization) {
    upstreamHeaders.set("authorization", authorization);
  }
  const requestBody = await request.text();
  const body = requestBody.trim() ? requestBody : "{}";
  try {
    const upstreamResponse = await fetchWithTimeout(env, upstreamUrl, {
      method: "POST",
      headers: upstreamHeaders,
      body
    });
    return buildUpstreamResponse(upstreamResponse, env, request);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg === "Upstream timeout") {
      return jsonResponse({ error: "Upstream timeout" }, env, 504);
    }
    return jsonResponse({ error: "Upstream error", message: errMsg }, env, 502);
  }
}
function prepareChatPayload(payload) {
  const rewrittenPayload = rewritePayload(payload);
  rewrittenPayload["stream"] = true;
  return rewrittenPayload;
}
function buildUpstreamResponse(upstreamResponse, env, request) {
  const responseHeaders = new Headers();
  for (const [name, value] of upstreamResponse.headers) {
    if (!RESPONSE_EXCLUDED.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  }
  const corsHeaders = buildCorsHeaders(env, request);
  for (const [name, value] of corsHeaders) {
    responseHeaders.set(name, value);
  }
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
}
async function buildNonStreamingChatResponse(upstreamResponse, env, request) {
  const chunks = parseSseJsonChunks(await upstreamResponse.text());
  const responseBody = buildChatCompletionResponse(chunks);
  const responseHeaders = new Headers({
    "content-type": "application/json; charset=utf-8"
  });
  const corsHeaders = buildCorsHeaders(env, request);
  for (const [name, value] of corsHeaders) {
    responseHeaders.set(name, value);
  }
  return new Response(JSON.stringify(responseBody), {
    status: upstreamResponse.status,
    headers: responseHeaders
  });
}
function parseSseJsonChunks(body) {
  const chunks = [];
  let dataLines = [];
  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join("\n").trim();
    dataLines = [];
    if (!data || data === "[DONE]") return;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        chunks.push(parsed);
      }
    } catch {
    }
  };
  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      flushEvent();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  flushEvent();
  return chunks;
}
function buildChatCompletionResponse(chunks) {
  const firstChunk = chunks[0] ?? {};
  const choices = /* @__PURE__ */ new Map();
  let usage;
  for (const chunk of chunks) {
    if (chunk["usage"]) {
      usage = chunk["usage"];
    }
    const chunkChoices = chunk["choices"];
    if (!Array.isArray(chunkChoices)) continue;
    for (let fallbackIndex = 0; fallbackIndex < chunkChoices.length; fallbackIndex++) {
      const chunkChoice = chunkChoices[fallbackIndex];
      if (!chunkChoice || typeof chunkChoice !== "object" || Array.isArray(chunkChoice)) continue;
      const choice = chunkChoice;
      const index = typeof choice["index"] === "number" ? choice["index"] : fallbackIndex;
      const aggregate = getAggregateChoice(choices, index);
      const delta = choice["delta"];
      if (delta && typeof delta === "object" && !Array.isArray(delta)) {
        mergeDelta(aggregate, delta);
      }
      if ("finish_reason" in choice) {
        aggregate["finish_reason"] = choice["finish_reason"];
      }
      if ("logprobs" in choice) {
        aggregate["logprobs"] = choice["logprobs"];
      }
    }
  }
  return {
    id: firstChunk["id"] ?? `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: typeof firstChunk["created"] === "number" ? firstChunk["created"] : Math.floor(Date.now() / 1e3),
    model: firstChunk["model"] ?? "",
    choices: Array.from(choices.values()).sort((a, b) => Number(a["index"]) - Number(b["index"])).map((choice) => ({
      index: choice["index"],
      message: choice["message"],
      logprobs: choice["logprobs"] ?? null,
      finish_reason: choice["finish_reason"] ?? "stop"
    })),
    ...usage ? { usage } : {}
  };
}
function getAggregateChoice(choices, index) {
  const existingChoice = choices.get(index);
  if (existingChoice) return existingChoice;
  const choice = {
    index,
    message: {
      role: "assistant",
      content: ""
    },
    finish_reason: null
  };
  choices.set(index, choice);
  return choice;
}
function mergeDelta(choice, delta) {
  const message = choice["message"];
  if (!message || typeof message !== "object" || Array.isArray(message)) return;
  const target = message;
  if (typeof delta["role"] === "string") {
    target["role"] = delta["role"];
  }
  if (typeof delta["content"] === "string") {
    target["content"] = `${target["content"] ?? ""}${delta["content"]}`;
  }
  if (typeof delta["reasoning_content"] === "string") {
    target["reasoning_content"] = `${target["reasoning_content"] ?? ""}${delta["reasoning_content"]}`;
  }
  if ("tool_calls" in delta) {
    target["tool_calls"] = delta["tool_calls"];
  }
}
function buildUpstreamUrl(env, requestUrl) {
  const base = env.UPSTREAM_CHAT_COMPLETIONS_URL || "https://copilot.tencent.com/v2/chat/completions";
  const reqUrl = new URL(requestUrl);
  if (reqUrl.search) {
    const separator = base.includes("?") ? "&" : "?";
    return `${base}${separator}${reqUrl.searchParams.toString()}`;
  }
  return base;
}
export {
  buildCorsHeaders,
  buildUpstreamUrl,
  index_default as default
};
