// src/utils.ts
var MODEL_SUFFIX_PATTERN = /^(.+)\[[^\]]+\]$/;
function normalizeModelId(modelId) {
  const trimmed = modelId.trim();
  const match = trimmed.match(MODEL_SUFFIX_PATTERN);
  return match ? match[1].trim() : trimmed;
}

// src/models.ts
var MODELS_DATA = {
  "code": 0,
  "msg": "OK",
  "requestId": "74f2854690df43769f8279e5011dc75d",
  "data": {
    "agents": [
      {
        "commands": ["init", "compact", "statusline", "insights"],
        "description": "cli agent",
        "instructions": "cli-agent-prompt",
        "modelTags": ["craft"],
        "models": [
          "hy3",
          "glm-5.2",
          "glm-5.1",
          "glm-5.0",
          "glm-5.0-turbo",
          "glm-5v-turbo",
          "glm-4.7",
          "minimax-m3",
          "minimax-m2.7",
          "kimi-k2.7",
          "kimi-k2.6",
          "kimi-k2.5",
          "deepseek-v4-pro",
          "deepseek-v4-flash",
          "deepseek-v3-2-volc"
        ],
        "name": "cli",
        "tags": ["cli", "default", "model:craft"],
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
        "credits": "x0.16 credits",
        "id": "deepseek-v4-pro",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 5e4,
        "name": "Deepseek-V4-Pro",
        "onlyReasoning": true,
        "reasoning": { "effort": "high", "summary": "auto" },
        "relatedModels": { "lite": "deepseek-v4-pro", "reasoning": "deepseek-v4-pro" },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "f"
      },
      {
        "credits": "x0.06 credits",
        "id": "deepseek-v4-flash",
        "maxAllowedSize": 1e6,
        "maxInputTokens": 1e6,
        "maxOutputTokens": 5e4,
        "name": "Deepseek-V4-Flash",
        "onlyReasoning": true,
        "reasoning": { "effort": "high", "summary": "auto" },
        "relatedModels": { "lite": "deepseek-v4-flash", "reasoning": "deepseek-v4-flash" },
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
        "reasoning": { "effort": "high", "summary": "auto" },
        "relatedModels": { "lite": "deepseek-v3-2-volc", "reasoning": "deepseek-v3-2-volc" },
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
        "reasoning": { "effort": "high", "summary": "auto" },
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
        "reasoning": { "effort": "medium", "summary": "auto" },
        "relatedModels": { "lite": "minimax-m3", "reasoning": "minimax-m3" },
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
        "reasoning": { "effort": "medium", "summary": "auto" },
        "relatedModels": { "lite": "minimax-m2.7", "reasoning": "minimax-m2.7" },
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
        "reasoning": { "effort": "medium", "summary": "auto" },
        "relatedModels": { "lite": "glm-5.2", "reasoning": "glm-5.2" },
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
        "reasoning": { "effort": "medium", "summary": "auto" },
        "relatedModels": { "lite": "glm-5.1", "reasoning": "glm-5.1" },
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
        "relatedModels": { "lite": "glm-5.0", "reasoning": "glm-5.0" },
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
        "reasoning": { "effort": "medium", "summary": "auto" },
        "relatedModels": { "lite": "glm-5.0-turbo", "reasoning": "glm-5.0-turbo" },
        "supportsImages": false,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.95 credits",
        "id": "glm-5v-turbo",
        "maxAllowedSize": 2e5,
        "maxInputTokens": 2e5,
        "maxOutputTokens": 64e3,
        "name": "GLM-5v-Turbo",
        "onlyReasoning": true,
        "reasoning": { "effort": "medium", "summary": "auto" },
        "relatedModels": { "lite": "glm-5v-turbo", "reasoning": "glm-5v-turbo" },
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
        "reasoning": { "effort": "high", "summary": "auto" },
        "supportsImages": true,
        "supportsReasoning": true,
        "supportsToolCall": true,
        "temperature": 1,
        "vendor": "e"
      },
      {
        "credits": "x0.57 credits",
        "id": "kimi-k2.7",
        "maxAllowedSize": 256e3,
        "maxInputTokens": 256e3,
        "maxOutputTokens": 32e3,
        "name": "Kimi-K2.7-Code",
        "onlyReasoning": true,
        "reasoning": { "effort": "medium", "summary": "auto" },
        "relatedModels": { "lite": "kimi-k2.7", "reasoning": "kimi-k2.7" },
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
        "reasoning": { "effort": "medium", "summary": "auto" },
        "relatedModels": { "lite": "kimi-k2.6", "reasoning": "kimi-k2.6" },
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
        "reasoning": { "effort": "high", "summary": "auto" },
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
        "reasoning": { "effort": "high", "summary": "auto" },
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
        "reasoning": { "effort": "high", "summary": "auto" },
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
        "id": "hunyuan-image-v3.0",
        "name": "Hunyuan Image V3",
        "tags": ["text-to-image"]
      }
    ],
    "productFeatures": {
      "CodeAdoptionRate": false
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
function getRawModelsData() {
  return MODELS_DATA;
}
function getAgents() {
  return MODELS_DATA.data.agents;
}
function getProductFeatures() {
  return MODELS_DATA.data.productFeatures;
}
export {
  MODELS_DATA,
  getAgents,
  getModelById,
  getModelsList,
  getProductFeatures,
  getRawModelsData
};
