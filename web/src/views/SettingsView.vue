<script setup lang="ts">
/**
 * 设置：运行配置（只读）+ 可写开关 + 会话操作。
 *
 * 运维台里「设置」的价值不是堆表单，而是把「当前部署到底按什么参数在跑」
 * 摊开给人看：上游地址、思考策略、限流阈值、会话时长、超时。
 * 这些值来自环境变量（Docker Compose），因此页面只读展示并提示改法。
 */
import { computed, onMounted, ref } from 'vue';
import { NButton, NCard, NSkeleton, NSwitch, NTooltip, useMessage } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import PageHeader from '../components/PageHeader.vue';
import { api, type DataResponse } from '../api';
import { useCopy } from '../clipboard';
import { loadConfig, loadSettings, saveSettings, store } from '../store';
import type { HistorySnapshot } from '../types';

const message = useMessage();
const copy = useCopy();
const saving = ref(false);
const archive = ref<HistorySnapshot | null>(null);

const config = computed(() => store.config);

/** 落盘与仅内存的数据边界：这张表决定了「容器重建后还剩什么」，值得写清楚 */
const persisted = ['上游凭证（AES-GCM 加密）', '网关 Key（仅存哈希）', '网关设置', '日/月用量归档'];
const inMemory = ['实时监控窗口（60 分钟）', '日志缓冲（最近 300 条）', '凭证冷却状态', '入口限流计数', '模型目录缓存'];

const historyRetentionDays = computed(() => archive.value?.retentionDays ?? 400);

const thinkingLabel = computed(() => {
  const mode = config.value?.thinkingMode ?? 'auto';
  return (
    {
      auto: '自动（思考独立下发）',
      thinking: '始终输出思考块',
      text: '并入正文',
      off: '丢弃思考',
    }[mode] ?? mode
  );
});

async function toggleAutoCheckin(value: boolean): Promise<void> {
  saving.value = true;
  try {
    await saveSettings({ autoCheckin: value });
    message.success(value ? '已开启自动签到' : '已关闭自动签到');
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    saving.value = false;
  }
}

async function logout(): Promise<void> {
  try {
    await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // 忽略网络错误,由服务端鉴权决定结果
  }
  window.location.href = '/admin';
}

interface Row {
  label: string;
  value: string;
  hint?: string;
  copyable?: boolean;
}

const rows = computed<Row[]>(() => {
  const cfg = config.value;
  if (!cfg) return [];
  return [
    { label: '凭证存储', value: cfg.storage === 'persistent' ? 'SQLite 持久化' : '内存（重启丢失）' },
    { label: '思考输出策略', value: thinkingLabel.value, hint: '由 EMIT_THINKING 控制' },
    { label: '入口限流', value: `${cfg.rateLimit.perMinute} 次/分钟 · 突发 ${cfg.rateLimit.burst}`, hint: '按来源 IP 计' },
    { label: '管理会话有效期', value: `${cfg.sessionTtlHours} 小时` },
    { label: '每日自动签到', value: cfg.checkinSchedule, hint: '进程内定时器' },
    { label: '上游总超时', value: `${cfg.timeout.totalSeconds} 秒` },
    { label: '上游连接超时', value: `${cfg.timeout.connectSeconds} 秒` },
  ];
});

const upstreamRows = computed<Row[]>(() => {
  const up = config.value?.upstream;
  if (!up) return [];
  return [
    { label: 'Chat Completions', value: up.chat, copyable: true },
    { label: '模型目录', value: up.config, copyable: true },
    { label: '额度查询', value: up.quota, copyable: true },
    { label: 'Token 刷新', value: up.refresh, copyable: true },
  ];
});

const gatewayBase = `${window.location.origin}/v1`;
const anthropicBase = window.location.origin;

onMounted(async () => {
  await Promise.all([loadConfig(true), loadSettings(true)]);
  try {
    // 归档保留天数由后端决定，这里只展示实际值，不写死
    const res = await api<DataResponse<HistorySnapshot>>('/admin/api/metrics/history', {
      query: { days: 1, months: 1 },
    });
    archive.value = res.data;
  } catch {
    // 归档不可用不影响设置页其余内容
  }
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="设置" desc="当前部署的运行参数（只读，来自环境变量）与会话操作" />

    <!-- 接入地址是最常被抄走的信息，独占整行 -->
    <NCard size="small" title="客户端接入地址">
      <div class="base">
        <div class="base-row">
          <span class="k">OpenAI 兼容 Base URL</span>
          <code class="mono">{{ gatewayBase }}</code>
          <NButton size="tiny" quaternary @click="copy(gatewayBase, '已复制 Base URL')">
            <template #icon><AppIcon name="copy" :size="13" /></template>
          </NButton>
        </div>
        <div class="base-row">
          <span class="k">Anthropic Base URL</span>
          <code class="mono">{{ anthropicBase }}</code>
          <NButton size="tiny" quaternary @click="copy(anthropicBase, '已复制 Anthropic URL')">
            <template #icon><AppIcon name="copy" :size="13" /></template>
          </NButton>
        </div>
      </div>
      <ul class="endpoints">
        <li><b class="mono">POST /v1/chat/completions</b></li>
        <li><b class="mono">POST /v1/messages</b></li>
        <li><b class="mono">POST /v1/responses</b></li>
      </ul>
    </NCard>

    <div class="grid">
      <NCard size="small" title="运行参数">
        <!-- 配置未到位时用骨架，避免渲染出一个「什么都没有」的空盒子 -->
        <div v-if="!config" class="rows-skeleton">
          <NSkeleton v-for="i in 6" :key="i" text :sharp="false" height="14px" />
        </div>
        <ul v-else class="rows">
          <li v-for="row in rows" :key="row.label">
            <span class="k">
              {{ row.label }}
              <NTooltip v-if="row.hint" trigger="hover">
                <template #trigger><AppIcon name="help" :size="12" class="hint-ico" /></template>
                {{ row.hint }}
              </NTooltip>
            </span>
            <b>{{ row.value }}</b>
          </li>
        </ul>
      </NCard>

      <NCard size="small" title="上游地址">
        <div v-if="!config" class="rows-skeleton">
          <NSkeleton v-for="i in 4" :key="i" text :sharp="false" height="14px" />
        </div>
        <ul v-else class="rows">
          <li v-for="row in upstreamRows" :key="row.label">
            <span class="k">{{ row.label }}</span>
            <b class="mono url">{{ row.value }}</b>
            <NButton
              v-if="row.copyable"
              size="tiny"
              quaternary
              @click="copy(row.value, `已复制 ${row.label}`)"
            >
              <template #icon><AppIcon name="copy" :size="13" /></template>
            </NButton>
          </li>
        </ul>
      </NCard>

      <NCard size="small" title="数据与留存">
        <ul class="tags">
          <li v-for="item in persisted" :key="item" class="tag-item">{{ item }}</li>
        </ul>
        <ul class="tags" style="margin-top: 8px">
          <li v-for="item in inMemory" :key="item" class="tag-item muted">{{ item }}</li>
        </ul>
        <div class="sub" style="margin-top: 12px">
          归档保留 {{ historyRetentionDays }} 天。
        </div>
      </NCard>

      <NCard size="small" title="会话与签到">
        <div class="session">
          <div>
            <div class="session-title">管理员会话</div>
            <div class="sub">{{ config?.sessionTtlHours ?? 8 }} 小时后失效</div>
          </div>
          <NButton secondary @click="logout">
            <template #icon><AppIcon name="logout" :size="14" /></template>
            退出登录
          </NButton>
        </div>

        <div class="session" style="margin-top: 16px">
          <div>
            <div class="session-title">每日自动签到</div>
            <div class="sub">{{ config?.checkinSchedule ?? 'UTC 03:17' }}</div>
          </div>
          <NSwitch
            :value="store.settings?.autoCheckin === true"
            :loading="saving"
            @update:value="toggleAutoCheckin"
          />
        </div>
      </NCard>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
  gap: 16px;
  align-items: start;
}

.base {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.base-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.base-row .k {
  font-size: 12.5px;
  color: var(--text-3);
  min-width: 150px;
}

.base-row code {
  flex: 1;
  min-width: 0;
  word-break: break-all;
  background: var(--surface-3);
  border-radius: 6px;
  padding: 5px 9px;
  font-size: 12.5px;
}

/* 端点清单：路径是主体，鉴权方式作为副标题贴着它 */
.endpoints {
  list-style: none;
  margin: 14px 0 10px;
  padding: 0;
  display: grid;
  gap: 1px;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  background: var(--border-soft);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.endpoints li {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 9px 12px;
  background: var(--surface);
  font-size: 12.5px;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 骨架与 .rows 同间距，配置到达后行位置不跳动 */
.rows-skeleton {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px 0;
}

.rows li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.rows .k {
  color: var(--text-3);
  min-width: 128px;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.rows b {
  font-weight: 550;
  text-align: right;
  margin-left: auto;
  word-break: break-all;
}

.url {
  font-size: 12px;
}

.hint-ico {
  opacity: 0.6;
}

/* ── 数据留存 ── */
.tags {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag-item {
  font-size: 11.5px;
  padding: 2px 9px;
  border-radius: 999px;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
}

.tag-item.muted {
  color: var(--text-3);
  background: var(--surface-3);
  border-color: var(--border-soft);
}

.session {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}

.session-title {
  font-weight: 600;
  margin-bottom: 2px;
}

:deep(.mono) {
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
