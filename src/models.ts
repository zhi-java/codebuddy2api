/**
 * Embedded model data from models.md.
 * Served at GET /v1/models in OpenAI-compatible format.
 */

import { normalizeModelId } from './utils';

// ── Raw model entries from the API ────────────────────────────────────────

interface ModelEntry {
  credits?: string;
  disabledMultimodal?: boolean;
  descriptionEn?: string;
  descriptionZh?: string;
  id: string;
  maxAllowedSize?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  name: string;
  onlyReasoning?: boolean;
  reasoning?: {
    effort?: string;
    summary?: string;
    canDisableThinking?: boolean;
    defaultEffort?: string;
    supportedEfforts?: string[];
  };
  relatedModels?: Record<string, string>;
  supportsImages?: boolean;
  supportsReasoning?: boolean;
  supportsToolCall?: boolean;
  tags?: string[];
  temperature?: number;
  top_p?: number;
  vendor?: string;
}

interface AgentEntry {
  commands: string[];
  description: string;
  instructions: string;
  modelTags?: string[];
  models: string[];
  name: string;
  tags: string[];
  tools: string[];
}

/** The full response shape from models.md */
interface ModelsResponse {
  code: number;
  msg: string;
  requestId: string;
  data: {
    agents: AgentEntry[];
    enterpriseId?: string;
    models: ModelEntry[];
    productFeatures: Record<string, boolean>;
  };
}

export const MODELS_DATA: ModelsResponse = {
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
        "maxAllowedSize": 56000,
        "maxInputTokens": 200000,
        "maxOutputTokens": 24000,
        "name": "Default",
        "supportsImages": false,
        "supportsToolCall": true,
        "vendor": "v"
      },
      {
        "credits": "x0.51 credits",
        "id": "deepseek-v4-pro",
        "maxAllowedSize": 1000000,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 50000,
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
        "maxAllowedSize": 1000000,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 50000,
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
        "maxAllowedSize": 96000,
        "maxInputTokens": 96000,
        "maxOutputTokens": 32000,
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
        "maxAllowedSize": 200000,
        "maxInputTokens": 200000,
        "maxOutputTokens": 48000,
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
        "descriptionZh": "原生多模态，擅长代码、智能体任务",
        "disabledMultimodal": false,
        "id": "minimax-m3",
        "maxAllowedSize": 512000,
        "maxInputTokens": 512000,
        "maxOutputTokens": 128000,
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
        "maxAllowedSize": 200000,
        "maxInputTokens": 200000,
        "maxOutputTokens": 48000,
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
        "maxAllowedSize": 1000000,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 48000,
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
        "descriptionZh": "原生多模态，擅长处理复杂的长程自主任务。",
        "id": "glm-5.3-flash",
        "maxAllowedSize": 1000000,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 32000,
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
        "maxAllowedSize": 1000000,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 48000,
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
        "maxAllowedSize": 200000,
        "maxInputTokens": 200000,
        "maxOutputTokens": 48000,
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
        "maxAllowedSize": 200000,
        "maxInputTokens": 200000,
        "maxOutputTokens": 48000,
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
        "maxAllowedSize": 200000,
        "maxInputTokens": 200000,
        "maxOutputTokens": 48000,
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
        "maxAllowedSize": 200000,
        "maxInputTokens": 200000,
        "maxOutputTokens": 64000,
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
        "maxAllowedSize": 200000,
        "maxInputTokens": 200000,
        "maxOutputTokens": 48000,
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
        "maxAllowedSize": 168000,
        "maxInputTokens": 168000,
        "maxOutputTokens": 32000,
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
        "maxAllowedSize": 128000,
        "maxInputTokens": 128000,
        "maxOutputTokens": 32000,
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
        "descriptionZh": "擅长处理复杂的长程自主任务，前端开发能力突出，同时在知识工作与科研推理上表现出色。",
        "id": "kimi-k3-1",
        "maxAllowedSize": 1000000,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 32000,
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
        "maxAllowedSize": 256000,
        "maxInputTokens": 256000,
        "maxOutputTokens": 32000,
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
        "maxAllowedSize": 256000,
        "maxInputTokens": 256000,
        "maxOutputTokens": 32000,
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
        "maxAllowedSize": 164000,
        "maxInputTokens": 164000,
        "maxOutputTokens": 32000,
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
        "maxAllowedSize": 164000,
        "maxInputTokens": 164000,
        "maxOutputTokens": 32000,
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
        "maxAllowedSize": 192000,
        "maxInputTokens": 192000,
        "maxOutputTokens": 64000,
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
        "descriptionZh": "混元思考模型，具有增强的推理能力",
        "disabledMultimodal": false,
        "id": "hy3-x",
        "maxAllowedSize": 192000,
        "maxInputTokens": 192000,
        "maxOutputTokens": 64000,
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
        "descriptionZh": "混元思考模型，具有增强的推理能力",
        "disabledMultimodal": false,
        "id": "hy4-preview",
        "maxAllowedSize": 1000000,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 64000,
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
        "descriptionZh": "混元思考模型，具有增强的推理能力",
        "disabledMultimodal": false,
        "id": "hy4-preview-x",
        "maxAllowedSize": 1000000,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 64000,
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
        "maxInputTokens": 200000,
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

// ── OpenAI-compatible model object ────────────────────────────────────────

const EPOCH = 1_719_360_000; // arbitrary stable timestamp

export interface OpenAIModel {
  id: string;
  object: 'model';
  created: number;
  owned_by: string;
  /** Extra metadata — not standard OpenAI, but useful for clients */
  _name?: string;
  _credits?: string;
  _vendor?: string;
  _supportsImages?: boolean;
  _supportsReasoning?: boolean;
  _supportsToolCall?: boolean;
  _maxInputTokens?: number;
  _maxOutputTokens?: number;
  _descriptionZh?: string;
  _descriptionEn?: string;
}

const VENDOR_NAMES: Record<string, string> = {
  e: 'tencent',
  f: 'techright',
  j: 'hunyuan',
  v: 'default',
};

/**
 * Build the OpenAI-compatible model list once.
 */
function buildModelList(): OpenAIModel[] {
  return MODELS_DATA.data.models.map((m) => ({
    id: m.id,
    object: 'model' as const,
    created: EPOCH,
    owned_by: VENDOR_NAMES[m.vendor ?? ''] || m.vendor || 'unknown',
    _name: m.name,
    _credits: m.credits,
    _vendor: m.vendor,
    _supportsImages: m.supportsImages,
    _supportsReasoning: m.supportsReasoning,
    _supportsToolCall: m.supportsToolCall,
    _maxInputTokens: m.maxInputTokens,
    _maxOutputTokens: m.maxOutputTokens,
    _descriptionZh: m.descriptionZh,
    _descriptionEn: m.descriptionEn,
  }));
}

const MODEL_LIST = buildModelList();

// ── Public exports ───────────────────────────────────────────────────────

/** OpenAI-compatible GET /v1/models response body */
export interface ModelsListResponse {
  object: 'list';
  data: OpenAIModel[];
}

/** Full list in OpenAI format */
export function getModelsList(): ModelsListResponse {
  return { object: 'list', data: MODEL_LIST };
}

/** Lookup a single model by ID (returns undefined if not found) */
export function getModelById(id: string): OpenAIModel | undefined {
  const normalizedId = normalizeModelId(id);
  return MODEL_LIST.find((m) => m.id === normalizedId);
}

/** Raw upstream-style response (proxy pass-through for GET /models) */
export function getRawModelsData(): ModelsResponse {
  return MODELS_DATA;
}

/** Agent list */
export function getAgents() {
  return MODELS_DATA.data.agents;
}

/** Product features */
export function getProductFeatures() {
  return MODELS_DATA.data.productFeatures;
}
