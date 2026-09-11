<script setup lang="ts">
/**
 * 总览：服务健康 + 实时流量。
 *
 * 回答运维最常问的三个问题：
 *   1. 服务现在好不好？→ 健康横幅 + KPI（成功率/延迟分位）
 *   2. 流量长什么样？→ 60 分钟时序图 + 按模型/接口分布
 *   3. 出问题了看哪里？→ 近期错误列表（带错误码与凭证）
 */
import { computed, h, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NCard,
  NDataTable,
  NTag,
  NTooltip,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import BreakdownList from '../components/BreakdownList.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import StatCard from '../components/StatCard.vue';
import TrafficChart from '../components/TrafficChart.vue';
import { api, type DataResponse } from '../api';
import { tick } from '../autoRefresh';
import { fmtClock, fmtDuration, fmtMs, fmtTokens, num } from '../format';
import { navigate } from '../router';
import { refreshAll, store } from '../store';
import type { MetricsSnapshot, RequestRecord } from '../types';

const message = useMessage();
const metrics = ref<MetricsSnapshot | null>(null);
const loading = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const res = await api<DataResponse<MetricsSnapshot>>('/admin/api/metrics');
    metrics.value = res.data;
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  await Promise.all([refreshAll(), load()]);
}

const totals = computed(() => metrics.value?.totals);
const counts = computed(() => store.state?.counts);

/** KPI 迷你趋势：把分钟序列压成 0-1 相对值 */
const trend = computed(() => (metrics.value?.series ?? []).slice(-30).map((item) => item.total));
const errorTrend = computed(() => (metrics.value?.series ?? []).slice(-30).map((item) => item.errors));
const tokenTrend = computed(() => (metrics.value?.series ?? []).slice(-30).map((item) => item.totalTokens));

/**
 * token 统计覆盖率:只有上游上报了 usage 的请求才计入 token 汇总。
 * 明确显示覆盖率,避免把「缺失用量」误读成「没有消耗」。
 */
const tokenCoverage = computed(() => {
  const current = totals.value;
  if (!current || current.total === 0) return '暂无请求';
  const { tokenReported, total } = current;
  return `${tokenReported}/${total} 次上报用量（${Math.round((tokenReported / total) * 100)}%）`;
});

const healthy = computed(() => {
  if (!counts.value || counts.value.credentials === 0) return null;
  const ratio = counts.value.healthy / counts.value.credentials;
  if (ratio === 1) return { type: 'success' as const, text: '全部凭证健康' };
  if (ratio >= 0.5) return { type: 'warning' as const, text: `${counts.value.healthy}/${counts.value.credentials} 凭证可用` };
  return { type: 'error' as const, text: `仅 ${counts.value.healthy}/${counts.value.credentials} 凭证可用` };
});

const recentColumns: DataTableColumns<RequestRecord> = [
  { title: '时间', key: 'at', width: 92, render: (row) => h('span', { class: 'mono' }, fmtClock(row.at)) },
  {
    title: '接口',
    key: 'path',
    width: 176,
    render: (row) => h('span', { class: 'mono' }, row.path),
  },
  { title: '模型', key: 'model', minWidth: 140, render: (row) => h('span', { class: 'mono' }, row.model || '—') },
  {
    title: '状态',
    key: 'status',
    width: 86,
    render: (row) =>
      h(
        NTag,
        {
          size: 'small',
          bordered: false,
          type: row.status < 400 ? 'success' : row.status >= 500 ? 'error' : 'warning',
        },
        { default: () => String(row.status) },
      ),
  },
  { title: '耗时', key: 'durationMs', width: 88, render: (row) => fmtMs(row.durationMs) },
  {
    title: 'Token',
    key: 'totalTokens',
    width: 96,
    render: (row) => h('span', { class: 'mono' }, row.totalTokens ? fmtTokens(row.totalTokens) : '—'),
  },
  {
    title: '凭证',
    key: 'credentialId',
    width: 150,
    render: (row) =>
      h(
        NTooltip,
        { trigger: 'hover' },
        {
          trigger: () => h('span', { class: 'mono sub' }, row.credentialId || (row.retried ? '已故障转移' : '—')),
          default: () => (row.retried ? '该请求发生凭证故障转移后成功' : row.credentialId ?? '未使用托管凭证'),
        },
      ),
  },
];

watch(tick, () => void load());

onMounted(refresh);
</script>

<template>
  <div class="page">
    <PageHeader title="总览" desc="服务运行状态与实时流量（进程内统计，重启后重新累计）">
      <NButton secondary :loading="loading" @click="refresh">
        <template #icon><AppIcon name="refresh" :size="15" /></template>
        刷新
      </NButton>
    </PageHeader>

    <!-- 健康横幅：一眼看清服务与凭证池状态 -->
    <div class="banner">
      <div class="banner-left">
        <span class="pulse" />
        <div>
          <div class="banner-title">网关运行中</div>
          <div class="sub">
            已运行 {{ fmtDuration(metrics?.uptime.uptimeMs) }}
            <template v-if="store.state"> · 存储 {{ store.state.storage === 'persistent' ? 'SQLite' : '内存' }}</template>
          </div>
        </div>
      </div>
      <div class="banner-right">
        <NTag v-if="healthy" :type="healthy.type" :bordered="false" size="small">{{ healthy.text }}</NTag>
        <NTag v-if="counts" :bordered="false" size="small" type="default">
          {{ counts.keys }} 个客户端 Key
        </NTag>
        <NButton v-if="counts && counts.credentials === 0" type="primary" size="small" @click="navigate('credentials')">
          添加上游凭证
        </NButton>
      </div>
    </div>

    <div class="kpis">
      <StatCard
        label="累计请求"
        :value="num(totals?.total ?? 0)"
        :hint="`最近 1 分钟 ${num(totals?.lastMinute ?? 0)} 次`"
        icon="activity"
        :trend="trend"
      />
      <StatCard
        label="成功率"
        :value="totals?.total ? `${totals.successRate}%` : '—'"
        :hint="`失败 ${num(totals?.error ?? 0)} 次`"
        icon="check"
        :tone="(totals?.total ?? 0) === 0 ? 'default' : (totals?.successRate ?? 0) >= 99 ? 'good' : (totals?.successRate ?? 0) >= 95 ? 'warn' : 'bad'"
      />
      <StatCard
        label="平均耗时"
        :value="fmtMs(totals?.avgDurationMs)"
        :hint="`P50 ${fmtMs(totals?.p50Ms)}`"
        icon="clock"
        tone="info"
      />
      <StatCard
        label="P95 耗时"
        :value="fmtMs(totals?.p95Ms)"
        :hint="`P99 ${fmtMs(totals?.p99Ms)}`"
        icon="activity"
        :tone="(totals?.p95Ms ?? 0) > 30_000 ? 'warn' : 'default'"
        :trend="errorTrend"
      />
      <StatCard
        label="Token 消耗"
        :value="fmtTokens(totals?.totalTokens)"
        :hint="`输入 ${fmtTokens(totals?.promptTokens)} · 输出 ${fmtTokens(totals?.completionTokens)}`"
        icon="activity"
        tone="info"
        :trend="tokenTrend"
      />
      <StatCard
        label="Token 速率"
        :value="totals ? `${fmtTokens(totals.avgTokensPerMinute)}/min` : '—'"
        :hint="tokenCoverage"
        icon="clock"
      />
    </div>

    <NCard size="small" class="chart-card">
      <template #header>请求量 · 最近 60 分钟</template>
      <template #header-extra>
        <div class="legend">
          <span><i class="swatch ok" />成功</span>
          <span><i class="swatch bad" />失败</span>
        </div>
      </template>
      <TrafficChart :series="metrics?.series ?? []" />
    </NCard>

    <div class="grid">
      <BreakdownList title="按模型" :stats="metrics?.byModel ?? []" empty-hint="暂无请求记录" />
      <BreakdownList title="按接口" :stats="metrics?.byPath ?? []" empty-hint="暂无请求记录" />
    </div>

    <div class="grid">
      <NCard size="small">
        <template #header>近期错误</template>
        <template #header-extra>
          <NButton quaternary size="tiny" @click="navigate('logs')">查看全部日志</NButton>
        </template>
        <div v-if="(metrics?.recentErrors ?? []).length === 0" class="all-good">
          <AppIcon name="check" :size="15" />
          <span>最近 {{ num(metrics?.recent.length ?? 0) }} 次请求均成功</span>
        </div>
        <ul v-else class="errors">
          <li v-for="item in metrics?.recentErrors ?? []" :key="item.at + item.path">
            <span class="mono time">{{ fmtClock(item.at) }}</span>
            <NTag size="small" :bordered="false" :type="item.status >= 500 ? 'error' : 'warning'">{{ item.status }}</NTag>
            <span class="mono path">{{ item.path }}</span>
            <span class="msg">{{ item.error || '上游返回错误' }}</span>
          </li>
        </ul>
      </NCard>

      <NCard size="small">
        <template #header>最近请求</template>
        <template #header-extra>
          <span class="sub">共 {{ num(metrics?.recent.length ?? 0) }} 条明细</span>
        </template>
        <NDataTable
          :columns="recentColumns"
          :data="metrics?.recent.slice(0, 8) ?? []"
          :bordered="false"
          :single-line="false"
          size="small"
          :scroll-x="836"
          :pagination="false"
        >
          <template #empty>
            <EmptyState
              icon="activity"
              title="暂无请求记录"
              desc="客户端调用网关后，这里会显示接口、模型、状态与耗时。"
            />
          </template>
        </NDataTable>
      </NCard>
    </div>
  </div>
</template>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  background: linear-gradient(90deg, var(--accent-soft), transparent 60%), var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 14px 18px;
  margin-bottom: 16px;
}

.banner-left {
  display: flex;
  align-items: center;
  gap: 14px;
}

.banner-title {
  font-size: 14.5px;
  font-weight: 600;
}

.banner-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pulse {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
  animation: pulse 2.4s var(--ease) infinite;
}

@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  50% {
    box-shadow: 0 0 0 8px transparent;
  }
}

.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.chart-card {
  margin-bottom: 16px;
}

.legend {
  display: flex;
  gap: 14px;
  font-size: 11.5px;
  color: var(--text-3);
}

.legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.swatch.ok {
  background: var(--chart-bar-strong);
}

.swatch.bad {
  background: var(--chart-error);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  gap: 16px;
  align-items: start;
}

.all-good {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--accent);
  font-size: 13px;
  padding: 18px 2px;
}

.errors {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 260px;
  overflow: auto;
}

.errors li {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  flex-wrap: wrap;
}

.time {
  color: var(--text-3);
}

.path {
  color: var(--text-2);
}

.msg {
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
</style>
