<script setup lang="ts">
/**
 * 对话 Playground：真流式的多轮对话调试台。
 *
 * 与「聚合后一次性返回」相比，这里的价值在于：
 *   - 逐字看到思考与正文，能判断流式是否真的通畅；
 *   - 保留多轮上下文，可复现客户端真实的多轮请求；
 *   - 显示耗时与 token 用量，便于评估上游表现；
 *   - 随时中止，并同步中断上游请求。
 */
import { computed, nextTick, onMounted, ref } from 'vue';
import {
  NButton,
  NCard,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NTag,
  useMessage,
} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import PageHeader from '../components/PageHeader.vue';
import { streamChatTest } from '../api';
import { useCopy } from '../clipboard';
import { fmtMs, fmtTime, usageNum } from '../format';
import { refreshCredentials, store } from '../store';
import type { PlaygroundMessage } from '../types';

const message = useMessage();
const copy = useCopy();

const credentialId = ref('');
const model = ref('deepseek-v4.1-flash');
const system = ref('');
const temperature = ref(1);
const maxTokens = ref(4096);
const draft = ref('你好，用一句话介绍你自己');

const messages = ref<PlaygroundMessage[]>([]);
const streaming = ref(false);
const controller = ref<AbortController | null>(null);
const scrollRef = ref<HTMLElement | null>(null);
/** 系统提示词收进折叠区：日常对话不改它，不该常驻占版面 */
const showAdvanced = ref(false);
/** 已折叠思考过程的消息下标。思考读一次就够，之后应让位给正文。 */
const collapsed = ref(new Set<number>());

function toggleReasoning(index: number): void {
  const next = new Set(collapsed.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  collapsed.value = next;
}

const modelOptions = [
  'deepseek-v4.1-flash',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'hy4-preview',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'kimi-k3-1',
  'minimax-m3',
].map((item) => ({ label: item, value: item }));

const credentialOptions = computed(() =>
  store.credentials.map((cred) => ({ label: `${cred.name}（${cred.status}）`, value: cred.id })),
);

const canSend = computed(() => !streaming.value && draft.value.trim().length > 0 && !!credentialId.value);

async function scrollToBottom(): Promise<void> {
  await nextTick();
  const holder = scrollRef.value;
  if (holder) holder.scrollTop = holder.scrollHeight;
}

async function send(): Promise<void> {
  if (!canSend.value) return;

  const question = draft.value.trim();
  messages.value.push({ role: 'user', content: question });
  const reply: PlaygroundMessage = { role: 'assistant', content: '' };
  messages.value.push(reply);
  draft.value = '';
  streaming.value = true;
  const startedAt = performance.now();

  const abort = new AbortController();
  controller.value = abort;
  await scrollToBottom();

  try {
    await streamChatTest(
      {
        credentialId: credentialId.value,
        model: model.value,
        system: system.value,
        message: question,
        temperature: temperature.value,
        maxTokens: maxTokens.value,
      },
      (event) => {
        if (event.type === 'reasoning') reply.reasoning = (reply.reasoning ?? '') + event.delta;
        else if (event.type === 'content') reply.content += event.delta;
        else if (event.type === 'usage') reply.usage = event.usage;
        else if (event.type === 'done') {
          reply.model = event.model;
          reply.finishReason = event.finishReason;
        } else if (event.type === 'error') reply.error = event.message;
        void scrollToBottom();
      },
      abort.signal,
    );
    reply.durationMs = performance.now() - startedAt;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      reply.error = '已手动中止';
    } else {
      reply.error = (err as Error).message;
    }
    reply.durationMs = performance.now() - startedAt;
  } finally {
    streaming.value = false;
    controller.value = null;
  }
}

function stop(): void {
  controller.value?.abort();
}

function clear(): void {
  messages.value = [];
}

async function copyReply(item: PlaygroundMessage): Promise<void> {
  await copy(item.content, '已复制回复正文');
}

onMounted(async () => {
  await refreshCredentials();
  credentialId.value = store.credentials[0]?.id ?? '';
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="对话" desc="用真实凭证流式对话，验证连通性、思考输出与首字延迟">
      <NButton secondary :disabled="messages.length === 0" @click="clear">
        <template #icon><AppIcon name="trash" :size="14" /></template>
        清空
      </NButton>
    </PageHeader>

    <div class="layout">
      <!-- 左：参数。极简下不用卡片包裹，直接以「标签 + 控件」纵向排列 -->
      <aside class="params">
        <div class="field">
          <label class="label">上游凭证</label>
          <NSelect v-model:value="credentialId" :options="credentialOptions" placeholder="选择凭证" size="small" />
        </div>

        <div class="field">
          <label class="label">模型</label>
          <NSelect v-model:value="model" :options="modelOptions" filterable tag size="small" />
        </div>

        <div class="field">
          <label class="label">温度</label>
          <NInputNumber v-model:value="temperature" :min="0" :max="2" :step="0.1" size="small" style="width: 100%" />
        </div>

        <div class="field">
          <label class="label">最大输出 tokens</label>
          <NInputNumber v-model:value="maxTokens" :min="64" :max="32768" :step="512" size="small" style="width: 100%" />
        </div>

        <!-- 系统提示词收进折叠区：日常对话不改它，不该常驻占版面 -->
        <div class="field">
          <button class="adv-toggle" type="button" @click="showAdvanced = !showAdvanced">
            <AppIcon name="chevron" :size="12" :style="{ transform: showAdvanced ? 'rotate(180deg)' : '' }" />
            高级参数
          </button>
          <div v-if="showAdvanced" class="adv">
            <label class="label">系统提示词</label>
            <NInput v-model:value="system" type="textarea" :rows="3" placeholder="你是 CodeBuddy 助手…" size="small" />
          </div>
        </div>
      </aside>

      <!-- 右：对话 -->
      <section class="chat">
        <div class="chat-head">
          <span class="sub" v-if="streaming">流式输出中…</span>
          <span class="sub" v-else>{{ messages.length }} 条消息</span>
        </div>

        <div ref="scrollRef" class="stream">
          <div v-if="messages.length === 0" class="blank">
            <AppIcon name="send" :size="24" />
            <b>还没有请求</b>
            <span>输入问题后发送，回复会逐字流式显示；思考过程可折叠查看。</span>
          </div>

          <div v-for="(item, index) in messages" :key="index" class="msg" :class="item.role">
            <div class="msg-role">
              <span class="who">{{ item.role === 'user' ? '我' : item.model || '模型' }}</span>
              <span v-if="item.durationMs" class="meta">{{ fmtMs(item.durationMs) }}</span>
              <span v-if="item.finishReason" class="meta">finish={{ item.finishReason }}</span>
              <button
                v-if="item.role === 'assistant' && item.content"
                class="copy-btn"
                type="button"
                title="复制回复正文"
                @click="copyReply(item)"
              >
                <AppIcon name="copy" :size="13" />
              </button>
            </div>

            <!-- 思考过程：左侧一条细线，不用彩色底 -->
            <div v-if="item.reasoning" class="reasoning" :class="{ collapsed: collapsed.has(index) }">
              <button class="reasoning-head" type="button" @click="toggleReasoning(index)">
                <AppIcon name="chevron" :size="12" class="chev" />
                思考过程
              </button>
              <pre class="reasoning-body">{{ item.reasoning }}</pre>
            </div>

            <div v-if="item.content" class="bubble">{{ item.content }}</div>
            <div v-else-if="streaming && item.role === 'assistant' && !item.error" class="bubble typing">
              <span class="dot" /><span class="dot" /><span class="dot" />
            </div>

            <div v-if="item.error" class="err">
              <AppIcon name="alert" :size="13" />
              <span>{{ item.error }}</span>
            </div>

            <div v-if="item.usage" class="usage">
              <span>输入 <b>{{ usageNum(item.usage, 'prompt_tokens') ?? '—' }}</b></span>
              <span>输出 <b>{{ usageNum(item.usage, 'completion_tokens') ?? '—' }}</b></span>
              <span>合计 <b>{{ usageNum(item.usage, 'total_tokens') ?? '—' }}</b> tokens</span>
            </div>
          </div>
        </div>

        <div class="composer">
          <NInput
            v-model:value="draft"
            type="textarea"
            :rows="2"
            :disabled="streaming"
            placeholder="输入消息，Enter 发送（Shift+Enter 换行）"
            @keydown.enter.exact.prevent="send"
          />
          <div class="composer-acts">
            <span class="sub">{{ canSend || streaming ? '' : '请选择凭证并输入内容' }}</span>
            <NButton v-if="streaming" type="error" secondary @click="stop">
              <template #icon><AppIcon name="stop" :size="14" /></template>
              中止
            </NButton>
            <NButton v-else type="primary" :disabled="!canSend" @click="send">
              <template #icon><AppIcon name="send" :size="14" /></template>
              发送
            </NButton>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  gap: 40px;
  align-items: start;
}

@media (max-width: 980px) {
  .layout {
    grid-template-columns: 1fr;
    gap: 28px;
  }
}

/* ── 左：参数 ──
   极简下不用卡片包裹，直接以「标签 + 控件」纵向排列，靠间距分组。 */
.params {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.adv-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: none;
  background: transparent;
  padding: 0;
  font-size: 12px;
  font-weight: 550;
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}

.adv-toggle:hover {
  color: var(--text);
}

.adv-toggle :deep(svg) {
  transition: transform var(--dur) var(--ease);
}

.adv {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 14px;
}

/* ── 右：对话 ──
   撑满视口剩余高度，输入框固定在底部 —— 这是聊天类界面的主流行为，
   也让「中止/发送」始终在拇指可及处。 */
.chat {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 208px);
  min-height: 440px;
  min-width: 0;
}

.chat-head {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 12px;
}

.stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding-right: 4px;
  scrollbar-gutter: stable;
}

.blank {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  color: var(--text-3);
}

.blank :deep(svg) {
  color: var(--line-strong);
}

.blank b {
  color: var(--text-2);
  font-size: 13.5px;
  font-weight: 600;
}

.blank span {
  font-size: 12.5px;
  max-width: 320px;
  line-height: 1.7;
}

.msg-role {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 9px;
}

.who {
  font-size: 11.5px;
  font-weight: 640;
  color: var(--text-2);
}

.meta {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--mono);
}

/* 复制按钮默认隐形，悬停浮现 */
.copy-btn {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  opacity: 0;
  transition: opacity 140ms var(--ease), color 140ms var(--ease);
}

.msg:hover .copy-btn,
.copy-btn:focus-visible {
  opacity: 1;
}

.copy-btn:hover {
  color: var(--accent);
}

/* 用户消息右对齐、浅底无边框。不用蓝色气泡 —— 蓝色是「可点击」专用。 */
.msg.user {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.msg.user .msg-role {
  justify-content: flex-end;
}

.msg.user .bubble {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: 11px 14px;
  font-size: 13px;
  line-height: 1.65;
  max-width: 76%;
}

.bubble {
  font-size: 13px;
  line-height: 1.75;
  max-width: 92%;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 思考过程：左侧一条细线，不用彩色底 —— 极简下不用背景色分区 */
.reasoning {
  border-left: 2px solid var(--line-strong);
  padding-left: 13px;
  margin-bottom: 14px;
  max-width: 92%;
}

.reasoning-head {
  display: flex;
  align-items: center;
  gap: 7px;
  border: none;
  background: transparent;
  padding: 0;
  margin-bottom: 7px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-3);
  transition: color var(--dur) var(--ease);
}

.reasoning-head:hover {
  color: var(--text-2);
}

.reasoning-head .chev {
  transition: transform var(--dur) var(--ease);
}

.reasoning.collapsed .reasoning-head .chev {
  transform: rotate(-90deg);
}

.reasoning-body {
  margin: 0;
  font-size: 12px;
  line-height: 1.75;
  color: var(--text-3);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow-y: auto;
  font-family: var(--mono);
}

.reasoning.collapsed .reasoning-body {
  display: none;
}

.typing {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.typing .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  animation: blink 1.2s infinite;
}

.typing .dot:nth-child(2) {
  animation-delay: 0.2s;
}

.typing .dot:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes blink {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}

.err {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 9px;
  color: var(--bad);
  font-size: 12.5px;
}

.usage {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-top: 11px;
  font-size: 11.5px;
  color: var(--text-3);
}

.usage b {
  font-weight: 600;
  color: var(--text-2);
  font-family: var(--mono);
}

.composer {
  margin-top: 18px;
  padding-top: 18px;
  border-top: 1px solid var(--line);
}

.composer-acts {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 10px;
}

@media (max-width: 980px) {
  .chat {
    height: auto;
  }

  .stream {
    max-height: 58vh;
  }
}
</style>
