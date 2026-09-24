/**
 * Token 估算（无第三方依赖）。
 *
 * 用途：`POST /v1/messages/count_tokens` 与请求前的上下文预检。
 *
 * ## 为什么自实现而不引 tokenizer
 *
 * 项目运行时零依赖（package.json 的 dependencies 为空），这是刻意的设计约束：
 * 网关要能在最小镜像里跑、不引入供应链风险。真正的 BPE tokenizer 需数 MB
 * 词表且各模型不同，与这个约束冲突。
 *
 * ## 精度取向
 *
 * 估算**宁可偏高不可偏低**：
 *   - 偏高只会让客户端提前压缩上下文，浪费一点窗口；
 *   - 偏低会让客户端以为塞得下，实际被上游 400 拒绝，是硬失败。
 * 因此这里的系数取自「偏保守」一侧，并对结构化开销（消息包装、工具定义）
 * 单独计费，而不是只算正文。
 *
 * Anthropic 侧实际也把它当估算用（官方 count_tokens 是精确值，但客户端
 * 普遍用它做启发式决策），同类网关（claude-code-router 等）亦为本地估算。
 */

/** 各模态的字符→token 折算率（字符数 / 该值 = 估算 token 数） */
const CHARS_PER_TOKEN = {
  /** 英文与代码：约为 4 字符/token */
  latin: 4,
  /** CJK：汉字通常 1–1.5 字符/token，取 1.6 偏保守 */
  cjk: 1.6,
  /** 其他（emoji、符号等）：按 2 字符/token 保守估计 */
  other: 2,
} as const;

/** 每条消息的固定包装开销（role、分隔符等） */
const PER_MESSAGE_OVERHEAD = 4;
/** 整个请求的固定开销 */
const REQUEST_OVERHEAD = 3;
/** 每个工具定义的固定开销（name/description/schema 包装） */
const PER_TOOL_OVERHEAD = 12;

function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // 日文假名
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xac00 && code <= 0xd7af) || // 韩文
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容
    (code >= 0xff00 && code <= 0xffef) // 全角字符
  );
}

/**
 * 估算一段文本的 token 数。
 *
 * 按字符类别分别折算再求和，而不是统一用一个系数——中英混排时
 * 统一系数会让中文占比高的请求严重低估（中文 1.6 字符/token vs 英文 4）。
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;

  let latin = 0;
  let cjk = 0;
  let other = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isCjk(code)) cjk++;
    else if (code <= 0x7f || (code >= 0x80 && code <= 0x24f)) latin++; // ASCII + 拉丁扩展
    else other++;
  }

  return (
    Math.ceil(latin / CHARS_PER_TOKEN.latin) +
    Math.ceil(cjk / CHARS_PER_TOKEN.cjk) +
    Math.ceil(other / CHARS_PER_TOKEN.other)
  );
}

/** 递归估算任意 JSON 值的 token 数（用于工具 schema 等结构化内容） */
function estimateJsonTokens(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return estimateTextTokens(value);
  if (typeof value === 'number' || typeof value === 'boolean') return 1;
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += estimateJsonTokens(item) + 1;
    return total;
  }
  if (typeof value === 'object') {
    let total = 0;
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      total += estimateTextTokens(key) + estimateJsonTokens(item) + 1;
    }
    return total;
  }
  return 0;
}

/**
 * 估算消息内容块的 token 数。
 *
 * 覆盖 Anthropic 的内容块类型：text / image / document / tool_use / tool_result
 * / thinking。图片按**保守固定值**计（无法从 base64 得知真实视觉 token 数，
 * 且不做图片解码以保持零依赖）。
 */
function estimateContentBlock(block: unknown): number {
  if (typeof block === 'string') return estimateTextTokens(block);
  if (!block || typeof block !== 'object') return 0;

  const record = block as Record<string, unknown>;
  const type = typeof record['type'] === 'string' ? record['type'] : '';

  switch (type) {
    case 'text':
      return estimateTextTokens(typeof record['text'] === 'string' ? record['text'] : '');
    case 'thinking':
      return estimateTextTokens(typeof record['thinking'] === 'string' ? record['thinking'] : '');
    case 'image': {
      // 视觉 token 与分辨率相关，官方口径通常在 ~1.5k 以内；
      // 取固定 1600 偏保守，避免客户端低估导致超窗。
      return 1600;
    }
    case 'document':
      return 2000;
    case 'tool_use':
      return estimateTextTokens(String(record['name'] ?? '')) + estimateJsonTokens(record['input']) + 6;
    case 'tool_result': {
      const content = record['content'];
      let total = 6;
      if (Array.isArray(content)) {
        for (const item of content) total += estimateContentBlock(item);
      } else if (typeof content === 'string') {
        total += estimateTextTokens(content);
      }
      return total;
    }
    default:
      // 未知块类型：整体序列化后估算，宁可偏高
      return estimateJsonTokens(record);
  }
}

/** 估算单条消息的 token 数（含包装开销） */
export function estimateMessageTokens(message: unknown): number {
  if (!message || typeof message !== 'object') return 0;
  const record = message as Record<string, unknown>;
  const content = record['content'];

  let total = PER_MESSAGE_OVERHEAD;
  if (typeof content === 'string') {
    total += estimateTextTokens(content);
  } else if (Array.isArray(content)) {
    for (const block of content) total += estimateContentBlock(block);
  } else if (content && typeof content === 'object') {
    total += estimateContentBlock(content);
  }
  return total;
}

export interface TokenEstimateInput {
  /** 消息列表（Anthropic messages 或 OpenAI messages 的并集形态） */
  messages?: unknown;
  /** Anthropic 的 system（字符串或内容块数组） */
  system?: unknown;
  /** 工具定义 */
  tools?: unknown;
}

/**
 * 估算一次请求的输入 token 总数。
 *
 * 计入 system、messages、tools —— 与 Anthropic count_tokens 的口径一致
 * （其定义为「messages、system prompt、tools 的总和」）。
 */
export function estimateInputTokens(input: TokenEstimateInput): number {
  let total = REQUEST_OVERHEAD;

  const { system, messages, tools } = input;

  if (typeof system === 'string') {
    total += estimateTextTokens(system);
  } else if (Array.isArray(system)) {
    for (const block of system) total += estimateContentBlock(block);
  }

  if (Array.isArray(messages)) {
    for (const message of messages) total += estimateMessageTokens(message);
  }

  if (Array.isArray(tools)) {
    for (const tool of tools) total += estimateJsonTokens(tool) + PER_TOOL_OVERHEAD;
  }

  return total;
}
