/**
 * Embedded model data from models.md.
 * Served at GET /v1/models in OpenAI-compatible format.
 */

import { extractUserIdFromJwt } from './crypto';
import { normalizeModelId } from './utils';
import type { UpstreamCredential } from './types';

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
  /** 常见兼容字段:部分客户端据此做上下文预检(缺失时可能误判) */
  context_window?: number;
  max_model_len?: number;
  /**
   * 上下文字段的多家别名。
   *
   * OpenAI 规范里**没有**上下文长度字段（只有 id/object/created/owned_by），
   * 各客户端因此各自约定字段名。实测（读源码）：
   *   - Cline / Continue 只从 /v1/models 取 **模型 ID**，不读任何长度字段；
   *   - 但仍有客户端读别名，且声明成本为零、不冲突。
   * 因此把常见约定一并给出，覆盖更多客户端而不是只满足 vLLM。
   */
  context_length?: number;
  max_input_tokens?: number;
  max_context_length?: number;
  /** 输出上限;与 context_window 分开,避免客户端把输入窗口误填进 max_tokens */
  max_output_tokens?: number;
  /** 部分客户端的兜底输出上限字段名 */
  max_tokens?: number;
  /** 思考档位:上游要求显式传 reasoning_effort 的模型据此补默认值 */
  _defaultEffort?: string;
  _supportedEfforts?: string[];
  _canDisableThinking?: boolean;
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
 * Build the OpenAI-compatible model list from a raw model array.
 */
function buildModelList(entries: ModelEntry[]): OpenAIModel[] {
  return entries.map((m) => ({
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
    // 上下文长度的多家别名一并给出（各家客户端约定不同，见 interface 注释）
    ...(typeof m.maxInputTokens === 'number'
      ? {
          context_window: m.maxInputTokens,
          max_model_len: m.maxInputTokens,
          context_length: m.maxInputTokens,
          max_input_tokens: m.maxInputTokens,
          max_context_length: m.maxInputTokens,
        }
      : {}),
    ...(typeof m.maxOutputTokens === 'number'
      ? { max_output_tokens: m.maxOutputTokens, max_tokens: m.maxOutputTokens }
      : {}),
    _defaultEffort: m.reasoning?.defaultEffort ?? m.reasoning?.effort,
    _supportedEfforts: m.reasoning?.supportedEfforts,
    _canDisableThinking: m.reasoning?.canDisableThinking,
    _descriptionZh: m.descriptionZh,
    _descriptionEn: m.descriptionEn,
  }));
}

/** Static fallback list, built from the embedded snapshot. */
const MODEL_LIST = buildModelList(MODELS_DATA.data.models);

/**
 * 最近一次成功拉取的上游实时目录。
 *
 * 上游会新增内置快照没有的模型(如 deepseek-v4.1-flash),这些模型的
 * 思考档位、输出上限等元数据只能从实时目录获得,因此缓存最近一次结果供
 * 请求链路查询。
 */
let liveCatalog: OpenAIModel[] | undefined;

function rememberUpstreamModels(models: OpenAIModel[]): void {
  liveCatalog = models;
}

/** 查询模型元数据:优先内置快照(稳定),其次最近一次上游实时目录。 */
export function findModelMetadata(id: string): OpenAIModel | undefined {
  const normalized = normalizeModelId(id);
  return MODEL_LIST.find((m) => m.id === normalized)
    ?? liveCatalog?.find((m) => m.id === normalized);
}

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




// ── Dynamic model discovery (client credential pass-through) ──────────────

/**
 * 上游配置接口地址。客户端凭证透传后由网关补齐必要的身份头。
 */
const DEFAULT_UPSTREAM_CONFIG_URL = 'https://copilot.tencent.com/v3/config';

/**
 * 上游要求客户端带上 IDE/CLI 身份头,否则返回 400（check ua）。
 * 这些是可公开的固定指纹头,不含任何用户凭据。
 */
const CONFIG_FINGERPRINT_HEADERS: Record<string, string> = {
  'user-agent': 'CLI/2.107.0 CodeBuddy/2.107.0',
  'x-ide-type': 'CLI',
  'x-ide-name': 'CLI',
  'x-ide-version': '2.107.0',
  'accept': 'application/json',
};

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 分钟
const CACHE_MAX_ENTRIES = 50;
const MODEL_FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  expiresAt: number;
  models: OpenAIModel[];
}

/** 按客户端凭证指纹缓存,多租户互不影响 */
const modelCache = new Map<string, CacheEntry>();

function cacheKeyFor(token: string, userId: string): string {
  // 只取 token 首尾片段做指纹,避免明文缓存完整凭据
  return `${token.length}:${token.slice(0, 8)}:${token.slice(-8)}:${userId}`;
}

function pruneCache(now: number): void {
  for (const [key, entry] of modelCache) {
    if (entry.expiresAt <= now) modelCache.delete(key);
  }
  // 超限时淘汰最早的条目(Map 保持插入顺序)
  while (modelCache.size > CACHE_MAX_ENTRIES) {
    const oldest = modelCache.keys().next();
    if (oldest.done) break;
    modelCache.delete(oldest.value);
  }
}

/**
 * 从上游拉取最新模型目录。
 *
 * - 使用解析后的上游凭证（网关 key → 托管凭证并自动刷新；透传模式为客户端原凭证）
 * - 自动补齐上游要求的固定身份头
 * - 成功返回 OpenAI 格式模型列表,失败返回 undefined（调用方应回退静态快照）
 */
export async function fetchUpstreamModels(
  credential: UpstreamCredential,
  env?: { UPSTREAM_CONFIG_URL?: string },
  options?: { forceRefresh?: boolean },
): Promise<OpenAIModel[] | undefined> {
  const token = credential.token;
  if (!token) return undefined;

  const userId = credential.userId ?? extractUserIdFromJwt(token);
  const cacheKey = cacheKeyFor(token, userId ?? 'anonymous');

  const now = Date.now();
  const cached = modelCache.get(cacheKey);
  if (!options?.forceRefresh && cached && cached.expiresAt > now) {
    return cached.models;
  }
  pruneCache(now);

  const headers = new Headers(CONFIG_FINGERPRINT_HEADERS);
  headers.set('authorization', `Bearer ${token}`);
  // 上游用 X-User-Id 标识请求主体;模型目录本身与身份无关,取不到时回退随机值
  headers.set('x-user-id', userId ?? crypto.randomUUID());

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_FETCH_TIMEOUT_MS);

  try {
    const upstreamUrl = env?.UPSTREAM_CONFIG_URL || DEFAULT_UPSTREAM_CONFIG_URL;
    const response = await fetch(upstreamUrl, { headers, signal: controller.signal });
    if (!response.ok) return undefined;

    const body = (await response.json()) as Partial<ModelsResponse>;
    const models = body?.data?.models;
    if (!Array.isArray(models) || models.length === 0) return undefined;

    const list = buildModelList(models as ModelEntry[]);
    rememberUpstreamModels(list);
    modelCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      models: list,
    });
    return list;
  } catch {
    // 网络错误 / 超时 / JSON 解析失败 —— 一律交给静态快照兜底
    return undefined;
  } finally {
    clearTimeout(timeoutId);
  }
}


// ── Anthropic-compatible model list ──────────────────────────────────────
//
// Claude Code 等 Anthropic 客户端读的是 Anthropic 自己的格式，与 OpenAI 不兼容：
//   OpenAI   : { object:"list", data:[ { id, object:"model", owned_by } ] }
//   Anthropic: { data:[ { id, type:"model", display_name, created_at,
//                        max_input_tokens, max_tokens, capabilities } ],
//                first_id, has_more, last_id }
//
// 实测证据：claude-code-router（专为 Claude Code 转接而建）即按 Anthropic
// 格式注入 max_input_tokens / max_tokens。若只回 OpenAI 格式，Anthropic
// 客户端拿不到上下文长度，只能落到自己的默认值。

/** Anthropic 的模型对象（字段名与官方 /v1/models 对齐） */
export interface AnthropicModel {
  id: string;
  type: 'model';
  display_name: string;
  created_at: string;
  max_input_tokens: number | null;
  max_tokens: number | null;
  capabilities: Record<string, unknown>;
}

/** Anthropic-compatible GET /v1/models response body */
export interface AnthropicModelsListResponse {
  data: AnthropicModel[];
  first_id: string | null;
  has_more: boolean;
  last_id: string | null;
}

/** 固定的模型发布时间：上游未提供，用稳定常量避免每次响应变化。 */
const ANTHROPIC_MODEL_EPOCH = '1970-01-01T00:00:00Z';

/**
 * 由模型元数据构造 Anthropic 能力块。
 *
 * 只声明**能从上游元数据确证**的能力。上游的 supportsToolCall /
 * supportsImages / supportsReasoning 直接映射；其余统一给 false，
 * 而不是乐观地报 true —— 谎报能力会让客户端启用上游不支持的特性。
 */
function buildCapabilities(model: OpenAIModel): Record<string, unknown> {
  const supportsThinking = Boolean(model._supportsReasoning || model._defaultEffort);
  const support = (value: boolean): { supported: boolean } => ({ supported: value });

  return {
    batch: support(false),
    citations: support(false),
    code_execution: support(false),
    context_management: {
      supported: true,
      ...(typeof model._maxInputTokens === 'number'
        ? { max_input_tokens: model._maxInputTokens }
        : {}),
    },
    effort: {
      supported: supportsThinking,
      ...(Array.isArray(model._supportedEfforts) && model._supportedEfforts.length > 0
        ? Object.fromEntries(model._supportedEfforts.map((level) => [level, support(true)]))
        : {}),
    },
    image_input: support(Boolean(model._supportsImages)),
    pdf_input: support(false),
    structured_outputs: support(false),
    thinking: {
      supported: supportsThinking,
      types: {
        adaptive: support(false),
        enabled: support(supportsThinking),
      },
    },
    tool_use: support(model._supportsToolCall !== false),
  };
}

/** 把一个模型元数据对象转成 Anthropic 格式 */
export function toAnthropicModel(model: OpenAIModel): AnthropicModel {
  const maxInput = typeof model._maxInputTokens === 'number' ? model._maxInputTokens : null;
  const maxOutput = typeof model._maxOutputTokens === 'number' ? model._maxOutputTokens : null;

  return {
    id: model.id,
    type: 'model',
    display_name: model._name ?? model.id,
    created_at: ANTHROPIC_MODEL_EPOCH,
    max_input_tokens: maxInput,
    max_tokens: maxOutput,
    capabilities: {
      ...buildCapabilities(model),
      // 供 Claude Code 判定 1M 上下文变体（其 `[1m]` 后缀依赖此标记）
      ...(maxInput !== null
        ? {
            context_window: {
              max_input_tokens: maxInput,
              supported: true,
              supports_1m_context: maxInput >= 1_000_000,
            },
          }
        : {}),
    },
  };
}

/** 把模型元数据数组构造成 Anthropic 列表响应 */
export function toAnthropicModelsList(models: OpenAIModel[]): AnthropicModelsListResponse {
  const data = models.map(toAnthropicModel);
  return {
    data,
    first_id: data[0]?.id ?? null,
    has_more: false,
    last_id: data[data.length - 1]?.id ?? null,
  };
}

/**
 * 浏览器/管理台模型目录：从网关托管凭证中选一个健康凭证实时拉取。
 *
 * 与 fetchUpstreamModels 的区别：后者由**调用方传入自己的凭证**（API 客户端路径），
 * 本函数自行从存储中挑选健康凭证——适用于「用户没有网关 Key 但需要看模型目录」
 * 的场景：公开模型页（浏览器）与管理台（cookie 会话）。
 * 不向调用方暴露任何凭证内容。
 *
 * 放在本模块（而非 index.ts 或 admin.ts）：两者都需要它，
 * 置于公共依赖层可避免 index ↔ admin 的循环引用。
 */
export async function resolveBrowserModelsList(
  env: { CREDENTIALS_KV?: unknown; CREDENTIALS_ENC_SECRET?: string; UPSTREAM_CONFIG_URL?: string },
): Promise<OpenAIModel[]> {
  try {
    const { getTokenStore } = await import('./store');
    const { getCredentialStatus } = await import('./credentials');
    const credentials = await getTokenStore(env as never).listCredentials();
    for (const credential of credentials) {
      const status = getCredentialStatus(credential);
      if (status !== 'healthy' && status !== 'error') continue;

      const token = credential.kind === 'ck_apikey' ? credential.apiKey : credential.accessToken;
      if (!token) continue;

      const models = await fetchUpstreamModels(
        {
          token,
          userId: credential.userId,
          kind: credential.kind,
          credentialId: credential.id,
        },
        env,
        { forceRefresh: true },
      );
      if (models?.length) return models;
    }
  } catch {
    // 凭证存储或上游异常时回退静态目录，页面仍可用
  }
  return getModelsList().data;
}
