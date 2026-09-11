/**
 * Anthropic Messages API 适配器(/v1/messages)。
 *
 * 请求方向:Anthropic Messages → OpenAI chat.completions(上游 CodeBuddy)
 * 响应方向:上游 chat SSE → Anthropic Messages SSE 事件流
 *
 * 映射要点:
 *   system → messages[0] role=system
 *   messages[].content blocks → 文本 / tool_use / tool_result(独立 tool 消息)
 *   tools[].input_schema → function.parameters
 *   tool_choice: any/auto/none → type 语义映射
 *   stop_reason: stop→end_turn, length→max_tokens, tool_calls→tool_use
 *   推理:上游 reasoning_content 仅在请求开启 thinking 时映射为 thinking 块,
 *         否则丢弃(避免未开启 thinking 的客户端收到意外块)。
 */

import { parseSseJsonChunks, SseChunk } from './sse';

// ── 工具 ───────────────────────────────────────────────────────────────────

function randId(prefix: string): string {
  const hex = crypto.randomUUID().replace(/-/g, '');
  return `${prefix}${hex}`;
}

function extractText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object')
      .map((b) => (b.type === 'text' ? String(b.text ?? '') : ''))
      .join('');
  }
  return '';
}

// ── 请求转换:Anthropic → Chat ──────────────────────────────────────────────

export interface AnthropicRequest {
  model?: unknown;
  max_tokens?: unknown;
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  top_k?: unknown;
  stop_sequences?: unknown;
  stream?: unknown;
  thinking?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

/** Anthropic messages[].content 数组里的 tool_result 展开为 tool 消息 */
function convertAnthropicMessage(msg: Record<string, unknown>): Record<string, unknown>[] {
  const role = String(msg.role ?? '');
  const content = msg.content;

  if (typeof content === 'string') {
    return [{ role, content }];
  }
  if (!Array.isArray(content)) {
    return role ? [{ role, content: '' }] : [];
  }

  const blocks = content;

  if (role === 'user') {
    const out: Record<string, unknown>[] = [];
    const textParts: string[] = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const type = String(b.type ?? '');

      if (type === 'text') {
        textParts.push(String(b.text ?? ''));
      } else if (type === 'tool_result') {
        out.push({
          role: 'tool',
          tool_call_id: String(b.tool_use_id ?? ''),
          content: extractText(b.content),
        });
      } else if (type === 'image') {
        // Anthropic image 块:组装为 OpenAI 多模态内容(与整体 user 文本合并)
        textParts.push(anthropicImageToText(b));
      }
    }

    if (out.length) {
      // 含 tool_result:先发 tool 消息,文本作为其后的 user 提问
      // (OpenAI 要求 assistant.tool_calls 后紧跟 tool 消息,不能夹 user)
      if (textParts.length) {
        out.push({ role: 'user', content: textParts.join('\n') });
      }
      return out;
    }

    if (textParts.length) {
      return [{ role: 'user', content: textParts.join('\n') }];
    }
    return [];
  }

  if (role === 'assistant') {
    const textParts: string[] = [];
    const toolCalls: Record<string, unknown>[] = [];

    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const type = String(b.type ?? '');

      if (type === 'text') {
        textParts.push(String(b.text ?? ''));
      } else if (type === 'tool_use') {
        toolCalls.push({
          id: String(b.id ?? randId('call_')),
          type: 'function',
          function: {
            name: String(b.name ?? ''),
            arguments: JSON.stringify(b.input ?? {}),
          },
        });
      }
      // thinking / redacted_thinking 等块:丢弃(上游输入不接受)
    }

    const out: Record<string, unknown> = {
      role: 'assistant',
      content: textParts.length ? textParts.join('') : null,
    };
    if (toolCalls.length) out.tool_calls = toolCalls;
    return [out];
  }

  // 其他角色(罕见):提取文本
  const text = extractText(blocks);
  return text ? [{ role, content: text }] : [];
}

/** Anthropic image 块 → data URL(上游若支持多模态才能使用;纯文本通道直接退化为占位描述) */
function anthropicImageToText(block: Record<string, unknown>): string {
  const source = block.source as Record<string, unknown> | undefined;
  if (!source) return '[图片]';
  const mediaType = String(source.media_type ?? 'image/png');
  const type = String(source.type ?? '');

  if (type === 'base64') {
    return `data:${mediaType};base64,${String(source.data ?? '')}`;
  }
  if (type === 'url') {
    return String(source.url ?? '[图片]');
  }
  return '[图片]';
}

/** 工具定义:Anthropic → OpenAI */
function convertAnthropicTools(tools: unknown): unknown[] | undefined {
  if (!Array.isArray(tools)) return undefined;

  const out: unknown[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const tool = t as Record<string, unknown>;

    // 已是 OpenAI 格式(双层透传场景)
    if (tool.function) {
      out.push(tool);
      continue;
    }

    const fn: Record<string, unknown> = { name: String(tool.name ?? '') };
    if (tool.description !== undefined) fn.description = tool.description;
    if (tool.input_schema !== undefined) fn.parameters = tool.input_schema;
    out.push({ type: 'function', function: fn });
  }
  return out.length ? out : undefined;
}

/** tool_choice:Anthropic → OpenAI */
function convertToolChoice(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value === 'any') return { type: 'required' };
    if (value === 'auto') return 'auto';
    if (value === 'none') return 'none';
    return { type: 'function', function: { name: value } };
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    const type = String(v.type ?? 'any');
    if (type === 'any') return { type: 'required' };
    if (type === 'tool') {
      return { type: 'function', function: { name: String(v.name ?? '') } };
    }
    return type;
  }
  return value;
}

/**
 * Anthropic Messages 请求 → OpenAI chat.completions 请求。
 * 返回的 payload 由调用方补充凭证并强制 stream=true。
 */
export function anthropicRequestToChat(body: AnthropicRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];

  const system = extractText(body.system);
  if (system) {
    messages.push({ role: 'system', content: system });
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!msg || typeof msg !== 'object') continue;
      messages.push(...convertAnthropicMessage(msg as Record<string, unknown>));
    }
  }

  const chat: Record<string, unknown> = {
    messages,
    stream: true,
  };

  if (body.model !== undefined) chat.model = body.model;
  if (body.max_tokens !== undefined) chat.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.top_k !== undefined) chat.top_k = body.top_k;
  if (Array.isArray(body.stop_sequences)) {
    chat.stop = body.stop_sequences;
  }

  const tools = convertAnthropicTools(body.tools);
  if (tools) chat.tools = tools;
  if (body.tool_choice !== undefined) chat.tool_choice = convertToolChoice(body.tool_choice);

  return chat;
}

// ── 响应转换:Chat SSE → Anthropic Messages ─────────────────────────────────

/** finish_reason → Anthropic stop_reason */
const STOP_REASON_MAP: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

export interface AnthropicConverterOptions {
  model: string;
  /** 请求开启 thinking 时,把上游 reasoning_content 映射为 thinking 块 */
  emitThinking?: boolean;
  /** 未输出 thinking 块时,将 reasoning 并入 text 正文(仅推理模型正文极短,合并后可见) */
  carryReasoning?: boolean;
}

interface ToolSlot {
  id: string;
  name: string;
  args: string;
  blockIndex: number;
  open: boolean;
}

/**
 * 上游 chunk 流 → Anthropic 事件字符串流。
 * 同时维护聚合状态,供非流式路径组装最终 message。
 */
export class AnthropicConverter {
  readonly messageId = randId('msg_');
  private readonly requestModel: string;
  private readonly emitThinking: boolean;
  private readonly carryReasoning: boolean;
  model = '';

  // 聚合状态
  textContent = '';
  reasoningContent = '';
  /** 思考已并入正文且已插入分隔标记 */
  private carriedGap = false;
  usage?: Record<string, unknown>;
  finishReason?: string;

  // 事件状态
  private emittedStart = false;
  private textBlockIndex = -1;
  private textBlockOpen = false;
  private nextBlockIndex = 0;
  private toolSlots = new Map<number, ToolSlot>();

  constructor({ model, emitThinking, carryReasoning }: AnthropicConverterOptions) {
    this.requestModel = model;
    this.model = model;
    this.emitThinking = Boolean(emitThinking);
    this.carryReasoning = Boolean(carryReasoning);
  }

  /** 喂入一个上游 chunk,返回需下发的 Anthropic SSE 文本(可能为空串) */
  feed(chunk: SseChunk): string {
    const events: string[] = [];

    if (typeof chunk.model === 'string') this.model = chunk.model;
    if (chunk.usage && typeof chunk.usage === 'object') this.usage = chunk.usage as Record<string, unknown>;

    if (!this.emittedStart) {
      events.push(this.event('message_start', { message: this.startMessage() }));
      this.emittedStart = true;
    }

    const choices = chunk.choices;
    if (!Array.isArray(choices)) return events.join('');

    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      const delta = c.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // 推理文本:thinking 块(客户端开启)/ 并入 text(默认,保证可见)
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (reasoning) {
        this.reasoningContent += reasoning;
        if (this.emitThinking) {
          if (!this.thinkingBlockOpen) {
            const index = this.nextBlockIndex++;
            this.thinkingBlockIndex = index;
            this.thinkingBlockOpen = true;
            events.push(this.event('content_block_start', {
              index,
              content_block: { type: 'thinking', thinking: '' },
            }));
          }
          events.push(this.event('content_block_delta', {
            index: this.thinkingBlockIndex,
            delta: { type: 'thinking_delta', thinking: reasoning },
          }));
        } else if (this.carryReasoning) {
          // 思考逐段并入正文(与正文之间由 content 首次追加时插入一次分隔)
          events.push(...this.pushText(reasoning));
        }
      }

      // 文本
      const content = typeof delta.content === 'string' ? delta.content : '';
      if (content) {
        // 思考已并入文本时,正文前插入一次空行分隔
        if (this.carryReasoning && this.reasoningContent && !this.carriedGap) {
          this.carriedGap = true;
          events.push(...this.pushText('\n\n'));
        }
        this.textContent += content;
        if (!this.textBlockOpen) {
          this.textBlockIndex = this.nextBlockIndex++;
          this.textBlockOpen = true;
          events.push(this.event('content_block_start', {
            index: this.textBlockIndex,
            content_block: { type: 'text', text: '' },
          }));
        }
        events.push(this.event('content_block_delta', {
          index: this.textBlockIndex,
          delta: { type: 'text_delta', text: content },
        }));
      }

      // 工具调用
      const toolCalls = delta.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const raw of toolCalls) {
          if (!raw || typeof raw !== 'object') continue;
          const tc = raw as Record<string, unknown>;
          const index = typeof tc.index === 'number' ? tc.index : 0;
          const fn = (tc.function ?? {}) as Record<string, unknown>;

          let slot = this.toolSlots.get(index);
          if (!slot) {
            slot = { id: '', name: '', args: '', blockIndex: -1, open: false };
            this.toolSlots.set(index, slot);
          }

          if (typeof tc.id === 'string' && tc.id) slot.id = tc.id;
          if (typeof fn.name === 'string' && fn.name) slot.name = fn.name;

          if (!slot.open) {
            slot.blockIndex = this.nextBlockIndex++;
            slot.open = true;
            events.push(this.event('content_block_start', {
              index: slot.blockIndex,
              content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
            }));
          }

          if (typeof fn.arguments === 'string' && fn.arguments) {
            slot.args += fn.arguments;
            events.push(this.event('content_block_delta', {
              index: slot.blockIndex,
              delta: { type: 'input_json_delta', partial_json: fn.arguments },
            }));
          }
        }
      }

      // 结束标记:关闭已打开的块
      if (typeof c.finish_reason === 'string' && c.finish_reason) {
        this.finishReason = c.finish_reason;
        events.push(...this.closeOpenBlocks());
      }
    }

    return events.join('');
  }

  private thinkingBlockIndex = -1;
  private thinkingBlockOpen = false;

  /** 向当前 text 块追加一段文本(无块则先开块),返回所需事件 */
  private pushText(segment: string): string[] {
    this.textContent += segment;
    const events: string[] = [];
    if (!this.textBlockOpen) {
      this.textBlockIndex = this.nextBlockIndex++;
      this.textBlockOpen = true;
      events.push(this.event('content_block_start', {
        index: this.textBlockIndex,
        content_block: { type: 'text', text: '' },
      }));
    }
    events.push(this.event('content_block_delta', {
      index: this.textBlockIndex,
      delta: { type: 'text_delta', text: segment },
    }));
    return events;
  }

  /** 关闭当前打开的 content 块(文本/思考/工具),返回所需事件 */
  private closeOpenBlocks(): string[] {
    const events: string[] = [];

    if (this.textBlockOpen) {
      events.push(this.event('content_block_stop', { index: this.textBlockIndex }));
      this.textBlockOpen = false;
    }
    if (this.thinkingBlockOpen) {
      events.push(this.event('content_block_stop', { index: this.thinkingBlockIndex }));
      this.thinkingBlockOpen = false;
    }
    for (const slot of this.toolSlots.values()) {
      if (slot.open) {
        events.push(this.event('content_block_stop', { index: slot.blockIndex }));
        slot.open = false;
      }
    }
    return events;
  }

  /** 流结束(或非流式收尾):补发 message_delta / message_stop */
  finish(): string {
    if (!this.emittedStart) {
      // 上游立即结束(空响应)
      this.emittedStart = true;
      return (
        this.event('message_start', { message: this.startMessage() }) +
        this.event('message_delta', {
          delta: { stop_reason: this.stopReason(), stop_sequence: null },
          usage: this.usageOutput(),
        }) +
        this.event('message_stop', {})
      );
    }

    const events: string[] = [];
    events.push(...this.closeOpenBlocks());
    events.push(this.event('message_delta', {
      delta: { stop_reason: this.stopReason(), stop_sequence: null },
      usage: this.usageOutput(),
    }));
    events.push(this.event('message_stop', {}));
    return events.join('');
  }

  private stopReason(): string {
    return STOP_REASON_MAP[this.finishReason ?? ''] ?? 'end_turn';
  }

  private usageOutput(): { input_tokens: number; output_tokens: number } | null {
    if (!this.usage) return null;
    return {
      input_tokens: num(this.usage.prompt_tokens) ?? num(this.usage.input_tokens) ?? 0,
      output_tokens: num(this.usage.completion_tokens) ?? num(this.usage.output_tokens) ?? 0,
    };
  }

  private startMessage(): Record<string, unknown> {
    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: this.model || this.requestModel,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  /** 组最终 message(非流式响应或测试断言用) */
  buildMessage(): Record<string, unknown> {
    const blocks: Record<string, unknown>[] = [];

    if (this.emitThinking && this.reasoningContent) {
      blocks.push({ type: 'thinking', thinking: this.reasoningContent });
    }
    if (this.textContent) {
      blocks.push({ type: 'text', text: this.textContent });
    }
    for (const slot of [...this.toolSlots.values()].sort((a, b) => a.blockIndex - b.blockIndex)) {
      if (!slot.name) continue;
      let input: unknown = {};
      try {
        input = JSON.parse(slot.args || '{}');
      } catch {
        input = slot.args;
      }
      blocks.push({ type: 'tool_use', id: slot.id, name: slot.name, input });
    }

    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      content: blocks,
      model: this.model || this.requestModel,
      stop_reason: this.stopReason(),
      stop_sequence: null,
      usage: this.usageOutput() ?? { input_tokens: 0, output_tokens: 0 },
    };
  }

  /** 便捷:一次性喂入多个 chunk(非流式路径) */
  feedAll(chunks: SseChunk[]): string {
    let out = '';
    for (const chunk of chunks) out += this.feed(chunk);
    return out;
  }

  /** 便捷:从上游 SSE 文本直接构建最终 message(非流式路径) */
  static fromUpstreamText(text: string, opts: AnthropicConverterOptions): AnthropicConverter {
    const converter = new AnthropicConverter(opts);
    converter.feedAll(parseSseJsonChunks(text));
    return converter;
  }

  private event(type: string, data: Record<string, unknown>): string {
    const payload = JSON.stringify({ type, ...data });
    return `event: ${type}\ndata: ${payload}\n\n`;
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
