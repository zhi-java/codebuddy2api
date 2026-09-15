/**
 * SSE 工具：上游 chat.completions SSE 流的解析与转发管道。
 *
 * 上游（CodeBuddy）流式响应是 OpenAI chat.completions 格式的 SSE：
 *   data: {"choices":[{"delta":{"content":"..."},"index":0}], ...}
 *   data: [DONE]
 *
 * 本模块提供两种消费方式：
 *   - parseSseJsonChunks(text)      —— 一次性解析（非流式聚合路径）
 *   - createSseReader() / SseLineReader —— 逐行喂入（流式转换路径）
 */

export interface SseChunk {
  [key: string]: unknown;
}

/**
 * 解析 SSE 文本为 JSON chunk 数组。
 * data: 行按空行聚合成事件;合并多行 data(joined by \n);忽略 [DONE] 与畸形内容。
 */
export function parseSseJsonChunks(body: string): SseChunk[] {
  const chunks: SseChunk[] = [];
  let dataLines: string[] = [];

  const flushEvent = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];

    if (!data || data === '[DONE]') return;

    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        chunks.push(parsed as SseChunk);
      }
    } catch {
      // Ignore malformed SSE events
    }
  };

  for (const line of body.split(/\r?\n/)) {
    if (line === '') {
      flushEvent();
      continue;
    }

    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  flushEvent();
  return chunks;
}

/**
 * 逐行 SSE 解析器（有状态）。
 *
 * 用法：
 *   const reader = createSseReader();
 *   reader.feed('data: {...}\n\n');      // 文本分片可跨 chunk 边界
 *   reader.feed('data: [DONE]\n\n');
 *   reader.eof();                        // 冲刷尾部残留
 */
export interface SseLineReader {
  /** 喂入一段文本（可能跨行/跨事件边界），返回解析出的 JSON chunk 列表 */
  feed(text: string): SseChunk[];
  /** 通知流结束,冲刷未完成事件,返回残留 chunk */
  eof(): SseChunk[];
}

export function createSseReader(): SseLineReader {
  let buffer = '';
  let dataLines: string[] = [];

  const flushEvent = (): SseChunk[] => {
    if (dataLines.length === 0) return [];

    const data = dataLines.join('\n').trim();
    dataLines = [];

    if (!data || data === '[DONE]') return [];

    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return [parsed as SseChunk];
      }
    } catch {
      // Ignore malformed SSE events
    }
    return [];
  };

  return {
    feed(text: string): SseChunk[] {
      buffer += text;
      const out: SseChunk[] = [];

      let idx: number;
      // 按行处理(保留行尾标记,以便识别空行=事件分隔)
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const rawLine = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);

        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
          out.push(...flushEvent());
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      return out;
    },

    eof(): SseChunk[] {
      // 处理残余的无换行文本
      const out: SseChunk[] = [];
      if (buffer.length > 0) {
        const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
        if (line === '') {
          out.push(...flushEvent());
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
          out.push(...flushEvent());
        }
        buffer = '';
      }
      return out;
    },
  };
}

/**
 * 把上游 SSE 字节流转换为「目标协议事件字节流」的 TransformStream。
 *
 * 用法（handler 内）：
 *   const transform = createSseTransformer(
 *     (chunk) => converter.feed(chunk),   // 每收到一个上游 JSON chunk
 *     () => converter.finish(),           // 流结束时收尾
 *   );
 *   return new Response(upstream.body.pipeThrough(transform), { headers });
 *
 * transform: 输入 ReadableStream<Uint8Array>(上游 body),
 *            输出 ReadableStream<Uint8Array>(转换后的事件文本)。
 */
export function createSseTransformer(
  onChunk: (chunk: SseChunk) => string,
  onEnd: () => string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const reader = createSseReader();
  const encoder = new TextEncoder();

  return new TransformStream({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      const events = reader.feed(text);
      for (const event of events) {
        const out = onChunk(event);
        if (out) controller.enqueue(encoder.encode(out));
      }
    },
    flush(controller) {
      // 冲刷残余事件
      for (const event of reader.eof()) {
        const out = onChunk(event);
        if (out) controller.enqueue(encoder.encode(out));
      }
      const tail = onEnd();
      if (tail) controller.enqueue(encoder.encode(tail));
    },
  });
}

/**
 * SSE 心跳保活 TransformStream。
 *
 * 上游思考期可能长时间静默(不吐分片),经中间代理/移动网络会被误判超时掐断。
 * 空闲超过 intervalMs 后注入标准 SSE 注释行 `: keep-alive`,客户端协议层会忽略。
 */
export function keepAliveTransform(intervalMs = 15_000): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;

  return new TransformStream({
    start(controller) {
      timer = setInterval(() => {
        controller.enqueue(encoder.encode(': keep-alive\n\n'));
      }, intervalMs);
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      if (timer !== undefined) clearInterval(timer);
    },
    cancel() {
      if (timer !== undefined) clearInterval(timer);
    },
  } as Transformer<Uint8Array, Uint8Array>);
}

/**
 * 生成一个空的 200 SSE 响应的辅助串(避免上游异常时客户端卡死)。
 */
export const SSE_DONE = 'data: [DONE]\n\n';

/**
 * 完成旁路:原样透传字节,并在流真正结束(flush)或被取消(cancel)时回调一次。
 *
 * 用于记录「凭证 + token/积分消耗」这类只有流末尾才齐全的信息 ——
 * 若在响应返回时就记,usage 尚未到达,日志里永远是空的。
 * 内部去重:flush 与 cancel 只会触发一次回调。
 */
export function completionTap(onComplete: () => void): TransformStream<Uint8Array, Uint8Array> {
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    onComplete();
  };
  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
    },
    flush() {
      fire();
    },
    cancel() {
      fire();
    },
  } as Transformer<Uint8Array, Uint8Array>);
}

/** 上游在流末尾给出的 token 用量 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /**
   * 上游实报的积分消耗(usage.credit)。
   * 实测为小数字符串/数字(如 0.01、2.5),免费模型为 0;
   * 缺失表示上游未上报 —— 不猜测、不估算。
   */
  credit?: number;
}

/** 从上游 usage 对象中取 credit(可能是 number 或数字字符串) */
function pickCredit(record: Record<string, unknown>): number | undefined {
  const raw = record['credit'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/**
 * SSE 用量旁路:原样透传字节,顺带提取上游在**流末尾**给出的 usage。
 *
 * 流式转发是纯透传(不解析、不聚合),所以这里先 enqueue 再解析 —— 解析失败
 * 或耗时都不会影响转发本身。只认第一个带 usage 的事件,重复事件不累加,
 * 由调用方用幂等写入兜底。
 */
export function usageTap(onUsage: (usage: TokenUsage) => void): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const reader = createSseReader();
  let reported = false;

  const inspect = (chunks: SseChunk[]): void => {
    if (reported) return;
    for (const chunk of chunks) {
      const usage = chunk['usage'];
      if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
      const record = usage as Record<string, unknown>;
      const promptTokens = typeof record['prompt_tokens'] === 'number' ? record['prompt_tokens'] : 0;
      const completionTokens = typeof record['completion_tokens'] === 'number' ? record['completion_tokens'] : 0;
      const credit = pickCredit(record);
      if (promptTokens === 0 && completionTokens === 0 && credit === undefined) continue;
      reported = true;
      onUsage({ promptTokens, completionTokens, ...(credit !== undefined ? { credit } : {}) });
      return;
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (reported) return;
      try {
        inspect(reader.feed(decoder.decode(chunk, { stream: true })));
      } catch {
        // 用量统计是旁路能力,解析失败不能影响响应转发
      }
    },
    flush() {
      if (reported) return;
      try {
        inspect(reader.eof());
      } catch {
        // 同上
      }
    },
  });
}

/**
 * 从已聚合的上游 SSE 文本中提取 token 用量(非流式路径用)。
 * 上游把 usage 放在最后一个事件里,这里取最后一个有效值。
 */
export function extractUsageFromSseText(body: string): TokenUsage | undefined {
  let found: TokenUsage | undefined;
  for (const chunk of parseSseJsonChunks(body)) {
    const usage = chunk['usage'];
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) continue;
    const record = usage as Record<string, unknown>;
    const promptTokens = typeof record['prompt_tokens'] === 'number' ? record['prompt_tokens'] : 0;
    const completionTokens = typeof record['completion_tokens'] === 'number' ? record['completion_tokens'] : 0;
    const credit = pickCredit(record);
    if (promptTokens === 0 && completionTokens === 0 && credit === undefined) continue;
    found = { promptTokens, completionTokens, ...(credit !== undefined ? { credit } : {}) };
  }
  return found;
}
