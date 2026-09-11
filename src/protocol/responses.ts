/**
 * OpenAI Responses API 适配器(/v1/responses)。
 *
 * 请求方向:Responses input items / instructions → OpenAI chat.completions
 * 响应方向:上游 chat SSE → Responses SSE 事件流(response.created → … → response.completed)
 *
 * 映射要点:
 *   instructions → system 消息
 *   input items:message(user/system/developer/assistant)、function_call、
 *               function_call_output → chat messages
 *   tools[{type:function}] → chat tools
 *   上游 reasoning_content 映射为 Responses reasoning summary 事件/输出项；
 *   未开启专用 reasoning 输出时，也可按调用方策略并入 output_text。
 */

import { parseSseJsonChunks, SseChunk } from './sse';

function randId(prefix: string): string {
  const hex = crypto.randomUUID().replace(/-/g, '');
  return `${prefix}${hex}`;
}

// ── 请求转换:Responses → Chat ──────────────────────────────────────────────

export interface ResponsesRequest {
  model?: unknown;
  instructions?: unknown;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  max_output_tokens?: unknown;
  reasoning?: unknown;
  stream?: unknown;
  store?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

/** 提取 content 文本(支持字符串与 [{type:text|input_text|output_text,text}] 与 [{type:image_url}] 多模态) */
function extractContentText(value: unknown, withImages: boolean): string {
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const p of value) {
      if (typeof p === 'string') {
        parts.push(p);
        continue;
      }
      if (!p || typeof p !== 'object') continue;
      const part = p as Record<string, unknown>;
      const type = String(part.type ?? '');
      if (type === 'input_text' || type === 'text' || type === 'output_text') {
        parts.push(String(part.text ?? ''));
      } else if (type === 'image_url' && withImages) {
        const img = part.image_url;
        if (img && typeof img === 'object') {
          const i = img as Record<string, unknown>;
          parts.push(String(i.url ?? '[图片]'));
        } else if (typeof img === 'string') {
          parts.push(img);
        } else {
          parts.push('[图片]');
        }
      }
    }
    return parts.join('');
  }
  return String(value ?? '');
}

interface ChatToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 把 Responses input items 数组转为 chat messages 序列 */
function convertInputItems(items: unknown): Record<string, unknown>[] {
  // 顶层字符串 input → 单条 user 消息(Responses API 允许)
  if (typeof items === 'string') {
    return [{ role: 'user', content: items }];
  }
  if (!Array.isArray(items)) return [];

  const messages: Record<string, unknown>[] = [];
  let pendingText = '';
  let pendingToolCalls: ChatToolCall[] = [];

  const flushAssistant = () => {
    if (pendingText === '' && pendingToolCalls.length === 0) return;
    const msg: Record<string, unknown> = {
      role: 'assistant',
      content: pendingText === '' ? null : pendingText,
    };
    if (pendingToolCalls.length) msg.tool_calls = pendingToolCalls;
    messages.push(msg);
    pendingText = '';
    pendingToolCalls = [];
  };

  for (const item of items) {
    // 裸字符串 input 项 → user 消息(Responses API 允许)
    if (typeof item === 'string') {
      flushAssistant();
      messages.push({ role: 'user', content: item });
      continue;
    }

    if (!item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    const type = it.type ? String(it.type) : undefined;
    const role = it.role ? String(it.role) : undefined;

    // 纯 role 消息(无 type)或 typed message
    if (type === 'message' || (type === undefined && role)) {
      const mappedRole =
        role === 'developer' ? 'system' : role === 'assistant' ? 'assistant' : role ?? 'user';

      if (mappedRole === 'assistant') {
        flushAssistant();
        pendingText = extractContentText(it.content, true);
        continue;
      }
      flushAssistant();
      messages.push({
        role: mappedRole,
        content: extractContentText(it.content, true),
      });
      continue;
    }

    // function_call → 合并进前一条 assistant 消息
    if (type === 'function_call') {
      if (!pendingToolCalls.length && messages.length && messages[messages.length - 1].role === 'assistant') {
        // 把已落库的 assistant 弹回待组装区(顺序上 function_call 紧跟 assistant 消息)
        const last = messages.pop() as Record<string, unknown>;
        pendingText = typeof last.content === 'string' ? last.content : '';
        if (Array.isArray(last.tool_calls)) pendingToolCalls = last.tool_calls as ChatToolCall[];
      }
      pendingToolCalls.push({
        id: String(it.call_id ?? it.id ?? randId('call_')),
        type: 'function',
        function: {
          name: String(it.name ?? ''),
          arguments: typeof it.arguments === 'string' ? it.arguments : JSON.stringify(it.arguments ?? {}),
        },
      });
      continue;
    }

    // function_call_output → tool 消息
    if (type === 'function_call_output') {
      flushAssistant();
      messages.push({
        role: 'tool',
        tool_call_id: String(it.call_id ?? ''),
        content: typeof it.output === 'string' ? it.output : JSON.stringify(it.output ?? ''),
      });
      continue;
    }

    // reasoning 等其余类型:忽略(上游无法消费)
  }

  flushAssistant();
  return messages;
}

/** 工具:Responses → Chat */
function convertTools(tools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(tools)) return undefined;

  const out: Record<string, unknown>[] = [];
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue;
    const tool = t as Record<string, unknown>;
    const type = String(tool.type ?? '');
    const name = String(tool.name ?? '');

    // 仅支持 function/custom 类工具;web_search/file_search 等交还给模型层的不做透传
    if (type === 'function' || (type === 'custom' && tool.function)) {
      const fn = (tool.function ?? {}) as Record<string, unknown>;
      out.push({
        type: 'function',
        function: {
          name: String(fn.name ?? name),
          ...(fn.description !== undefined ? { description: fn.description } : {}),
          ...(fn.parameters !== undefined ? { parameters: fn.parameters } : {}),
        },
      });
      continue;
    }
    if (type === 'custom' || type === 'web_search' || type === 'file_search') {
      // 网关不执行这些工具:跳过,避免上游报未知工具
      continue;
    }
  }
  return out.length ? out : undefined;
}

/**
 * Responses 请求 → OpenAI chat.completions 请求(stream 由调用方强制)。
 */
export function responsesRequestToChat(body: ResponsesRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];

  const instructions = extractContentText(body.instructions, false);
  if (instructions) {
    messages.push({ role: 'system', content: instructions });
  }

  messages.push(...convertInputItems(body.input));

  const chat: Record<string, unknown> = { messages, stream: true };

  if (body.model !== undefined) chat.model = body.model;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;

  const tools = convertTools(body.tools);
  if (tools) chat.tools = tools;
  if (body.tool_choice !== undefined && typeof body.tool_choice !== 'string') {
    const tc = body.tool_choice as Record<string, unknown>;
    const name = String(tc.name ?? '');
    if (typeof tc.type === 'string' && name) {
      chat.tool_choice = { type: 'function', function: { name } };
    }
  } else if (typeof body.tool_choice === 'string') {
    chat.tool_choice = body.tool_choice;
  }

  return chat;
}

// ── 响应转换:Chat SSE → Responses 事件流 ───────────────────────────────────

interface FcSlot {
  id: string;
  name: string;
  args: string;
  outputIndex: number;
  emitted: boolean;
}

export interface ResponsesConverterOptions {
  model: string;
  /** 输出 Responses 原生 reasoning summary item */
  emitReasoning?: boolean;
  /** 不输出 reasoning item 时,将推理文本并入 output_text */
  carryReasoning?: boolean;
}

/**
 * 上游 chunk 流 → Responses SSE 事件字符串流。
 */
export class ResponsesConverter {
  readonly responseId = randId('resp_');
  readonly itemId = randId('msg_');
  private readonly requestModel: string;
  private readonly emitReasoning: boolean;
  private readonly carryReasoning: boolean;
  private readonly textOutputIndex: number;
  model = '';
  private createdAt = Math.floor(Date.now() / 1000);

  // 聚合状态
  content = '';
  reasoningContent = '';
  usage?: Record<string, unknown>;
  finishReason?: string;

  // 事件状态
  private emittedCreated = false;
  private emittedReasoningItem = false;
  private carriedReasoningGap = false;
  readonly reasoningId = randId('rs_');
  private emittedMsgItem = false;
  private emittedContentPart = false;
  private toolSlots = new Map<number, FcSlot>();

  constructor({ model, emitReasoning, carryReasoning }: ResponsesConverterOptions) {
    this.requestModel = model;
    this.model = model;
    this.emitReasoning = Boolean(emitReasoning);
    this.carryReasoning = Boolean(carryReasoning);
    this.textOutputIndex = this.emitReasoning ? 1 : 0;
  }

  /** 喂入一个上游 chunk,返回 Responses SSE 文本 */
  feed(chunk: SseChunk): string {
    const events: string[] = [];

    if (typeof chunk.model === 'string') this.model = chunk.model;
    if (chunk.usage && typeof chunk.usage === 'object') this.usage = chunk.usage as Record<string, unknown>;

    // 首个 chunk:补发 created + in_progress
    if (!this.emittedCreated) {
      events.push(this.event('response.created', { response: this.responseObj('in_progress') }));
      events.push(this.event('response.in_progress', { response: this.responseObj('in_progress') }));
      this.emittedCreated = true;
    }

    const choices = chunk.choices;
    if (!Array.isArray(choices)) return events.join('');

    for (const choice of choices) {
      if (!choice || typeof choice !== 'object') continue;
      const c = choice as Record<string, unknown>;
      const delta = c.delta as Record<string, unknown> | undefined;
      if (!delta) continue;

      // 推理文本:Responses 原生 reasoning summary,或并入 output_text
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
      if (reasoning) {
        this.reasoningContent += reasoning;
        if (this.emitReasoning) {
          events.push(...this.pushReasoning(reasoning));
        } else if (this.carryReasoning) {
          if (this.content && !this.carriedReasoningGap) {
            this.content += '\n\n';
            this.carriedReasoningGap = true;
            events.push(this.event('response.output_text.delta', {
              output_index: this.textOutputIndex,
              content_index: 0,
              delta: '\n\n',
            }));
          }
          this.content += reasoning;
          events.push(...this.pushTextDelta(reasoning));
        }
      }

      // 文本
      const content = typeof delta.content === 'string' ? delta.content : '';
      if (content) {
        if (this.carryReasoning && this.reasoningContent && !this.carriedReasoningGap) {
          this.content += '\n\n';
          this.carriedReasoningGap = true;
          events.push(this.event('response.output_text.delta', {
            output_index: this.textOutputIndex,
            content_index: 0,
            delta: '\n\n',
          }));
        }
        if (!this.emittedMsgItem) {
          events.push(this.event('response.output_item.added', {
            output_index: this.textOutputIndex,
            item: this.messageItem('in_progress', true),
          }));
          this.emittedMsgItem = true;
        }
        if (!this.emittedContentPart) {
          events.push(this.event('response.content_part.added', {
            output_index: this.textOutputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          }));
          this.emittedContentPart = true;
        }

        this.content += content;
        events.push(this.event('response.output_text.delta', {
          output_index: this.textOutputIndex,
          content_index: 0,
          delta: content,
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
            const base = this.emittedMsgItem || this.content
              ? this.textOutputIndex + 1
              : this.textOutputIndex;
            slot = {
              id: '',
              name: '',
              args: '',
              outputIndex: base + this.toolSlots.size,
              emitted: false,
            };
            this.toolSlots.set(index, slot);
          }

          if (typeof tc.id === 'string' && tc.id) slot.id = tc.id;
          if (typeof fn.name === 'string' && fn.name) slot.name = fn.name;

          if (!slot.emitted) {
            events.push(this.event('response.output_item.added', {
              output_index: slot.outputIndex,
              item: this.functionCallItem(slot, 'in_progress'),
            }));
            slot.emitted = true;
          }

          if (typeof fn.arguments === 'string' && fn.arguments) {
            slot.args += fn.arguments;
            events.push(this.event('response.function_call_arguments.delta', {
              output_index: slot.outputIndex,
              delta: fn.arguments,
            }));
          }
        }
      }

      if (typeof c.finish_reason === 'string' && c.finish_reason) {
        this.finishReason = c.finish_reason;
      }
    }

    return events.join('');
  }

  private pushReasoning(text: string): string[] {
    const events: string[] = [];
    if (!this.emittedReasoningItem) {
      events.push(this.event('response.output_item.added', {
        output_index: 0,
        item: this.reasoningItem('in_progress'),
      }));
      events.push(this.event('response.reasoning_summary_part.added', {
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        part: { type: 'summary_text', text: '' },
      }));
      this.emittedReasoningItem = true;
    }
    events.push(this.event('response.reasoning_summary_text.delta', {
      item_id: this.reasoningId,
      output_index: 0,
      summary_index: 0,
      delta: text,
    }));
    return events;
  }

  private pushTextDelta(text: string): string[] {
    const events: string[] = [];
    if (!this.emittedMsgItem) {
      events.push(this.event('response.output_item.added', {
        output_index: this.textOutputIndex,
        item: this.messageItem('in_progress', true),
      }));
      this.emittedMsgItem = true;
    }
    if (!this.emittedContentPart) {
      events.push(this.event('response.content_part.added', {
        output_index: this.textOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      }));
      this.emittedContentPart = true;
    }
    events.push(this.event('response.output_text.delta', {
      output_index: this.textOutputIndex,
      content_index: 0,
      delta: text,
    }));
    return events;
  }

  private reasoningItem(status: string): Record<string, unknown> {
    return {
      type: 'reasoning',
      id: this.reasoningId,
      status,
      summary: [{ type: 'summary_text', text: this.reasoningContent }],
    };
  }

  /** 流收尾:补发各 item done 与 response.completed */
  finish(): string {
    const events: string[] = [];

    // 确保 created 已发(上游空响应兜底)
    if (!this.emittedCreated) {
      events.push(this.event('response.created', { response: this.responseObj('in_progress') }));
      events.push(this.event('response.in_progress', { response: this.responseObj('in_progress') }));
      this.emittedCreated = true;
    }

    if (this.emittedReasoningItem) {
      events.push(this.event('response.reasoning_summary_text.done', {
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        text: this.reasoningContent,
      }));
      events.push(this.event('response.reasoning_summary_part.done', {
        item_id: this.reasoningId,
        output_index: 0,
        summary_index: 0,
        part: { type: 'summary_text', text: this.reasoningContent },
      }));
      events.push(this.event('response.output_item.done', {
        output_index: 0,
        item: this.reasoningItem('completed'),
      }));
    }

    if (this.emittedMsgItem || this.content || this.toolSlots.size) {
      if (this.emittedMsgItem || this.content) {
        events.push(this.event('response.output_text.done', {
          output_index: this.textOutputIndex,
          content_index: 0,
          text: this.content,
        }));
        events.push(this.event('response.content_part.done', {
          output_index: this.textOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text: this.content, annotations: [] },
        }));
        events.push(this.event('response.output_item.done', {
          output_index: this.textOutputIndex,
          item: this.messageItem('completed', false),
        }));
      }

      for (const slot of [...this.toolSlots.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
        events.push(this.event('response.function_call_arguments.done', {
          output_index: slot.outputIndex,
          arguments: slot.args,
        }));
        events.push(this.event('response.output_item.done', {
          output_index: slot.outputIndex,
          item: this.functionCallItem(slot, 'completed'),
        }));
      }
    }

    events.push(this.event('response.completed', { response: this.responseObj('completed') }));
    return events.join('');
  }

  private messageItem(status: string, empty: boolean): Record<string, unknown> {
    return {
      type: 'message',
      id: this.itemId,
      status,
      role: 'assistant',
      content: empty
        ? []
        : [{ type: 'output_text', text: this.content, annotations: [] }],
    };
  }

  private functionCallItem(slot: FcSlot, status: string): Record<string, unknown> {
    return {
      type: 'function_call',
      id: randId('fc_'),
      call_id: slot.id,
      name: slot.name,
      arguments: slot.args,
      status,
    };
  }

  private usageObj(): Record<string, unknown> | null {
    if (!this.usage) return null;
    const details = this.usage.completion_tokens_details;
    const reasoningTokens = details && typeof details === 'object' && !Array.isArray(details)
      ? num((details as Record<string, unknown>).reasoning_tokens)
      : null;
    return {
      input_tokens: num(this.usage.prompt_tokens) ?? num(this.usage.input_tokens) ?? 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: num(this.usage.completion_tokens) ?? num(this.usage.output_tokens) ?? 0,
      output_tokens_details: { reasoning_tokens: num(this.usage.reasoning_tokens) ?? reasoningTokens ?? 0 },
      total_tokens: num(this.usage.total_tokens) ?? 0,
    };
  }

  private responseObj(status: string): Record<string, unknown> {
    const output: Record<string, unknown>[] = [];
    if (this.emittedReasoningItem) output.push(this.reasoningItem(status));
    if (this.emittedMsgItem || this.content) output.push(this.messageItem(status, false));
    for (const slot of [...this.toolSlots.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
      if (slot.emitted) output.push(this.functionCallItem(slot, status));
    }

    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model || this.requestModel,
      output,
      parallel_tool_calls: true,
      usage: this.usageObj(),
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      metadata: {},
      reasoning: null,
      store: false,
      temperature: null,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: [],
      top_p: null,
      truncation: 'disabled',
    };
  }

  /** 便捷:一次性喂入多个 chunk(非流式路径) */
  feedAll(chunks: SseChunk[]): string {
    let out = '';
    for (const chunk of chunks) out += this.feed(chunk);
    return out;
  }

  /** 非流式路径:从上游 SSE 文本直接组装 response object */
  static fromUpstreamText(text: string, opts: ResponsesConverterOptions): ResponsesConverter {
    const converter = new ResponsesConverter(opts);
    converter.feedAll(parseSseJsonChunks(text));
    return converter;
  }

  /** 非流式响应的最终 response 对象(在 feedAll 后调用) */
  buildResponse(): Record<string, unknown> {
    return this.responseObj('completed');
  }

  private event(type: string, data: Record<string, unknown>): string {
    const payload = JSON.stringify({ type, ...data });
    return `event: ${type}\ndata: ${payload}\n\n`;
  }
}

function num(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}
