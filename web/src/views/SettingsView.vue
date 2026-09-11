<script setup lang="ts">
/**
 * 设置：运行配置（只读）+ 可写开关 + 会话操作。
 *
 * 运维台里「设置」的价值不是堆表单，而是把「当前部署到底按什么参数在跑」
 * 摊开给人看：上游地址、思考策略、限流阈值、会话时长、超时。
 * 这些值来自环境变量（Docker Compose），因此页面只读展示并提示改法。
 */
import { computed, onMounted, ref } from 'vue';
import { NButton, NCard, NTag, NTooltip, useMessage } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import PageHeader from '../components/PageHeader.vue';
import { loadConfig, loadSettings, saveSettings, store } from '../store';
import { fmtDuration } from '../format';

const message = useMessage();
const saving = ref(false);
const copyTarget = ref('');

const config = computed(() => store.config);

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

async function copy(value: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    copyTarget.value = label;
    message.success(`已复制${label}`);
    window.setTimeout(() => {
      if (copyTarget.value === label) copyTarget.value = '';
    }, 1500);
  } catch {
    message.error('复制失败');
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
});
</script>

<template>
  <div class="page">
    <PageHeader title="设置" desc="当前部署的运行参数（只读，来自环境变量）与会话操作" />

    <div class="grid">
      <NCard size="small" title="客户端接入地址">
        <div class="base">
          <div class="base-row">
            <span class="k">OpenAI 兼容 Base URL</span>
            <code class="mono">{{ gatewayBase }}</code>
            <NButton size="tiny" quaternary @click="copy(gatewayBase, 'Base URL')">
              <template #icon><AppIcon name="copy" :size="13" /></template>
            </NButton>
          </div>
          <div class="base-row">
            <span class="k">Anthropic Base URL</span>
            <code class="mono">{{ anthropicBase }}</code>
            <NButton size="tiny" quaternary @click="copy(anthropicBase, 'Anthropic URL')">
              <template #icon><AppIcon name="copy" :size="13" /></template>
            </NButton>
          </div>
          <div class="sub">
            端点为 /v1/chat/completions、/v1/messages、/v1/responses；密钥在「API Keys」创建。
          </div>
        </div>
      </NCard>

      <NCard size="small" title="运行参数">
        <ul class="rows">
          <li v-for="row in rows" :key="row.label">
            <span class="k">
              {{ row.label }}
              <NTooltip v-if="row.hint" trigger="hover">
                <template #trigger><AppIcon name="alert" :size="12" class="hint-ico" /></template>
                {{ row.hint }}
              </NTooltip>
            </span>
            <b>{{ row.value }}</b>
          </li>
        </ul>
      </NCard>

      <NCard size="small" title="上游地址">
        <ul class="rows">
          <li v-for="row in upstreamRows" :key="row.label">
            <span class="k">{{ row.label }}</span>
            <b class="mono url">{{ row.value }}</b>
            <NButton v-if="row.copyable" size="tiny" quaternary @click="copy(row.value, row.label)">
              <template #icon><AppIcon name="copy" :size="13" /></template>
            </NButton>
          </li>
        </ul>
        <div class="sub" style="margin-top: 10px">
          修改上游地址、限流阈值或思考策略需要调整 docker-compose.yml 的环境变量后重启容器。
        </div>
      </NCard>

      <NCard size="small" title="会话与安全">
        <div class="session">
          <div>
            <div class="session-title">管理员会话</div>
            <div class="sub">
              会话使用 HMAC 签名 cookie，{{ config?.sessionTtlHours ?? 8 }} 小时后自动失效；凭证在落盘前经 AES-GCM 加密。
            </div>
          </div>
          <NButton secondary @click="logout">
            <template #icon><AppIcon name="logout" :size="14" /></template>
            退出登录
          </NButton>
        </div>
        <div class="session" style="margin-top: 14px">
          <div>
            <div class="session-title">每日自动签到</div>
            <div class="sub">开启后每天 {{ config?.checkinSchedule ?? 'UTC 03:17' }} 对全部启用凭证执行签到。</div>
          </div>
          <NTag :type="store.settings?.autoCheckin ? 'success' : 'default'" :bordered="false" size="small">
            {{ store.settings?.autoCheckin ? '已开启' : '已关闭' }}
          </NTag>
        </div>
        <div class="session-actions">
          <NButton
            size="small"
            secondary
            :loading="saving"
            @click="toggleAutoCheckin(!(store.settings?.autoCheckin === true))"
          >
            切换签到开关
          </NButton>
          <span class="sub">（也可在「上游凭证」页操作）</span>
        </div>
      </NCard>

      <NCard size="small" title="进程内状态">
        <div class="sub">
          限流计数、凭证冷却、模型目录缓存、监控统计与日志缓冲都保存在进程内存中，容器重启即清零；
          需要长期留存请以 <code class="mono">docker logs</code> 为准。
        </div>
        <ul class="rows" style="margin-top: 10px">
          <li>
            <span class="k">客户端 Key 数</span><b>{{ store.state?.counts.keys ?? 0 }}</b>
          </li>
          <li>
            <span class="k">上游凭证数</span><b>{{ store.state?.counts.credentials ?? 0 }}</b>
          </li>
          <li>
            <span class="k">健康凭证</span><b>{{ store.state?.counts.healthy ?? 0 }}</b>
          </li>
          <li>
            <span class="k">服务已运行</span><b>{{ fmtDuration(Date.now() - (store.refreshedAt || Date.now())) }}</b>
          </li>
        </ul>
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

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.session-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 14px;
}

:deep(.mono) {
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
