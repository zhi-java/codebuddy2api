<script setup lang="ts">
/**
 * 试跑 Playground：真流式的多轮对话调试台。
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
    <PageHeader title="试跑" desc="用真实凭证流式对话，验证连通性、思考输出与首字延迟">
      <NButton secondary :disabled="messages.length === 0" @click="clear">
        <template #icon><AppIcon name="trash" :size="15" /></template>
        清空对话
      </NButton>
    </PageHeader>

    <div class="layout">
      <!-- 左：参数 -->
      <NCard size="small" class="params">
        <template #header>请求参数</template>
        <NForm label-placement="top" size="small">
          <NFormItem label="上游凭证">
            <NSelect v-model:value="credentialId" :options="credentialOptions" placeholder="选择凭证" />
          </NFormItem>
          <NFormItem label="模型">
            <NSelect v-model:value="model" :options="modelOptions" filterable tag />
          </NFormItem>
          <NFormItem label="系统提示（可选）">
            <NInput v-model:value="system" type="textarea" :rows="3" placeholder="你是 CodeBuddy 助手…" />
          </NFormItem>
          <div class="two">
            <NFormItem label="温度">
              <NInputNumber v-model:value="temperature" :min="0" :max="2" :step="0.1" style="width: 100%" />
            </NFormItem>
            <NFormItem label="最大输出 tokens">
              <NInputNumber v-model:value="maxTokens" :min="64" :max="32768" :step="512" style="width: 100%" />
            </NFormItem>
          </div>
        </NForm>
        <div class="sub">凭证与模型决定上游账号；失败会在此直接显示上游错误码。</div>
      </NCard>

      <!-- 右：对话 -->
      <NCard size="small" class="chat">
        <template #header>
          <span>对话</span>
          <NTag v-if="streaming" size="small" :bordered="false" type="info" style="margin-left: 8px">流式输出中</NTag>
        </template>
        <template #header-extra>
          <span class="sub">{{ messages.length }} 条消息</span>
        </template>

        <div ref="scrollRef" class="stream">
          <NEmpty v-if="messages.length === 0" description="输入问题后发送，回复会逐字流式显示" />
          <div v-for="(item, index) in messages" :key="index" class="msg" :class="item.role">
            <div class="msg-head">
              <span class="who">{{ item.role === 'user' ? '我' : '模型' }}</span>
              <span v-if="item.model" class="sub mono">{{ item.model }}</span>
              <span v-if="item.durationMs" class="sub">{{ fmtMs(item.durationMs) }}</span>
              <span v-if="item.finishReason" class="sub">finish={{ item.finishReason }}</span>
              <NButton v-if="item.role === 'assistant' && item.content" quaternary size="tiny" @click="copyReply(item)">
                <template #icon><AppIcon name="copy" :size="13" /></template>
              </NButton>
            </div>

            <div v-if="item.reasoning" class="reasoning">
              <div class="reasoning-head">
                <AppIcon name="activity" :size="13" />
                <span>思考过程</span>
              </div>
              <pre class="mono">{{ item.reasoning }}</pre>
            </div>

            <div v-if="item.content" class="bubble">
              <pre class="mono">{{ item.content }}</pre>
            </div>
            <div v-else-if="streaming && item.role === 'assistant' && !item.error" class="bubble typing">
              <span class="dot" /><span class="dot" /><span class="dot" />
            </div>

            <div v-if="item.error" class="error">
              <AppIcon name="alert" :size="14" />
              <span>{{ item.error }}</span>
            </div>

            <div v-if="item.usage" class="usage">
              <span>输入 {{ usageNum(item.usage, 'prompt_tokens') ?? '—' }}</span>
              <span>输出 {{ usageNum(item.usage, 'completion_tokens') ?? '—' }}</span>
              <span>合计 {{ usageNum(item.usage, 'total_tokens') ?? '—' }} tokens</span>
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
          <div class="composer-actions">
            <NButton v-if="streaming" type="warning" secondary @click="stop">
              <template #icon><AppIcon name="stop" :size="15" /></template>
              停止
            </NButton>
            <NButton v-else type="primary" :disabled="!canSend" @click="send">
              <template #icon><AppIcon name="send" :size="15" /></template>
              发送
            </NButton>
          </div>
        </div>
      </NCard>
    </div>
  </div>
</template>

<style scoped>
.layout {
  display: grid;
  grid-template-columns: minmax(260px, 320px) 1fr;
  gap: 16px;
  align-items: start;
}

@media (max-width: 1020px) {
  .layout {
    grid-template-columns: 1fr;
  }
}

.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

/*
 * 对话区撑满视口剩余高度，输入框固定在底部：
 * 这是聊天类界面的主流行为，也让「停止/发送」始终在拇指可及处。
 * 减去的是顶栏 + 内容内边距 + 页头的高度。
 */
.chat {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 208px);
  min-height: 460px;
}

.chat :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.stream {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding-right: 4px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

@media (max-width: 1020px) {
  .chat {
    height: auto;
  }

  .stream {
    max-height: 60vh;
  }
}

.msg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  color: var(--text-3);
  font-size: 11.5px;
}

.who {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}

.bubble {
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 10px 12px;
}

.msg.user .bubble {
  background: var(--accent-soft);
  border-color: transparent;
}

.bubble pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.65;
}

.reasoning {
  border-left: 2px solid var(--border);
  padding-left: 10px;
  margin-bottom: 8px;
}

.reasoning-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-3);
  margin-bottom: 4px;
}

.reasoning pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  color: var(--text-3);
  max-height: 200px;
  overflow: auto;
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

.error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  color: var(--danger);
  font-size: 12.5px;
}

.usage {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.composer {
  margin-top: 12px;
  border-top: 1px solid var(--border-soft);
  padding-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

:deep(.mono) {
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
