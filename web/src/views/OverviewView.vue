<script setup lang="ts">
/**
 * 总览：先回答「服务现在好不好」，再回答「这段时间用了多少」。
 *
 * 信息分三层，权重依次下降，避免上一版把 7 张同权重卡片平铺导致的失焦：
 *   1. 实时层（进程内 60 分钟窗口）：健康横幅 + 速率/成功率/P95/Token 速率 + 流量时序
 *   2. 归档层（持久化日/月桶）：用量趋势（按日 / 按月 × 请求量 / Token / 积分）+ 明细表
 *   3. 明细层：按模型/接口分布、近期错误、最近请求
 *
 * 两层数据口径不同，界面分别标注来源，不把「重启即清零的实时值」和
 * 「跨重启保留的归档值」混为一谈。
 */
import { computed, h, onMounted, ref, watch } from 'vue';
import {
  NButton,
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
import SegmentedControl from '../components/SegmentedControl.vue';
import StatCard from '../components/StatCard.vue';
import TrafficChart from '../components/TrafficChart.vue';
import TrendBars from '../components/TrendBars.vue';
import { api, type DataResponse } from '../api';
import { tick } from '../autoRefresh';
import {
  delta,
  fmtClock,
  fmtCredit,
  fmtDayLabel,
  fmtDayShort,
  fmtDuration,
  fmtMonthLabel,
  fmtMonthShort,
  fmtMs,
  fmtTokens,
  num,
} from '../format';
import { navigate } from '../router';
import { refreshAll, store } from '../store';
import type {
  DayBucket,
  HistorySnapshot,
  MetricTotals,
  MetricsSnapshot,
  MonthBucket,
  RequestRecord,
  TrendMetric,
  TrendPoint,
} from '../types';

const message = useMessage();
const metrics = ref<MetricsSnapshot | null>(null);
const history = ref<HistorySnapshot | null>(null);
const loading = ref(false);

/** 归档区间：日视图取 30 天，月视图取 12 个月 */
const DAY_RANGE = 30;
const MONTH_RANGE = 12;

const trendGrain = ref<'day' | 'month'>('day');
const trendMetric = ref<TrendMetric>('requests');
const showTable = ref(false);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [live, archive] = await Promise.all([
      api<DataResponse<MetricsSnapshot>>('/admin/api/metrics'),
      api<DataResponse<HistorySnapshot>>('/admin/api/metrics/history', {
        query: { days: DAY_RANGE, months: MONTH_RANGE },
      }),
    ]);
    metrics.value = live.data;
    history.value = archive.data;
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    loading.value = false;
  }
}

async function refresh(): Promise<void> {
  await Promise.all([refreshAll(), load()]);
}

watch(tick, () => void load());
onMounted(refresh);

// ── 实时层 ────────────────────────────────────────────────────────────────

const totals = computed(() => metrics.value?.totals);
const counts = computed(() => store.state?.counts);

/** 迷你趋势：实时 KPI 共用最近 30 分钟窗口，够看出方向又不至于糊成噪点 */
const liveWindow = computed(() => (metrics.value?.series ?? []).slice(-30));
const requestTrend = computed(() => liveWindow.value.map((item) => item.total));
const errorTrend = computed(() => liveWindow.value.map((item) => item.errors));
const tokenTrend = computed(() => liveWindow.value.map((item) => item.totalTokens));
/** 每分钟平均耗时：由该分钟的耗时总和除以其请求数得出 */
const latencyTrend = computed(() =>
  liveWindow.value.map((item) => (item.total > 0 ? item.durationSumMs / item.total : 0)),
);

const successTone = computed(() => {
  const current = totals.value;
  if (!current || current.total === 0) return 'default' as const;
  if (current.successRate >= 99) return 'good' as const;
  if (current.successRate >= 95) return 'warn' as const;
  return 'bad' as const;
});

const health = computed(() => {
  const current = counts.value;
  if (!current || current.credentials === 0) return null;
  if (current.healthy === current.credentials) return { type: 'success' as const, text: `凭证 ${current.healthy}/${current.credentials} 健康` };
  if (current.healthy > 0) return { type: 'warning' as const, text: `凭证 ${current.healthy}/${current.credentials} 可用` };
  return { type: 'error' as const, text: '无可用凭证' };
});

/** token 覆盖率：上游未上报用量的请求不计入，标注清楚避免误读为「没消耗」 */
const tokenCoverage = computed(() => {
  const current = totals.value;
  if (!current || current.total === 0) return '暂无请求';
  return `${current.tokenReported}/${current.total} 次上报用量`;
});

const creditCoverage = computed(() => {
  const current = totals.value;
  if (!current || current.total === 0) return '暂无请求';
  return `${current.creditReported}/${current.total} 次上报积分`;
});

// ── 归档层 ────────────────────────────────────────────────────────────────

const archiveEnabled = computed(() => history.value?.enabled === true);

function tokensOf(bucket: MetricTotals): number {
  return bucket.promptTokens + bucket.completionTokens;
}

function metricValue(bucket: MetricTotals): number {
  if (trendMetric.value === 'tokens') return tokensOf(bucket);
  if (trendMetric.value === 'credit') return bucket.credit;
  return bucket.total;
}

function formatMetric(value: number): string {
  if (trendMetric.value === 'tokens') return fmtTokens(value);
  if (trendMetric.value === 'credit') return fmtCredit(value);
  return num(value);
}

const metricLabel = computed(
  () => ({ requests: '请求量', tokens: 'Token', credit: '积分' })[trendMetric.value],
);

const trendPoints = computed<TrendPoint[]>(() => {
  const snapshot = history.value;
  if (!snapshot) return [];

  const toPoint = (key: string, label: string, title: string, bucket: MetricTotals): TrendPoint => ({
    key,
    label,
    title,
    total: bucket.total,
    success: bucket.success,
    error: bucket.error,
    tokens: tokensOf(bucket),
    credit: bucket.credit,
  });

  if (trendGrain.value === 'month') {
    return snapshot.months.map((item: MonthBucket) =>
      toPoint(item.month, fmtMonthShort(item.month), fmtMonthLabel(item.month), item),
    );
  }
  return snapshot.days.map((item: DayBucket) =>
    toPoint(item.day, fmtDayShort(item.day), fmtDayLabel(item.day), item),
  );
});

/** 今日 / 昨日 / 本月 / 环比：跟随当前度量切换，读数始终自洽 */
const usageSummary = computed(() => {
  const snapshot = history.value;
  if (!snapshot || snapshot.days.length < 2) return null;

  const today = snapshot.days[snapshot.days.length - 1];
  const yesterday = snapshot.days[snapshot.days.length - 2];
  const thisMonth = snapshot.months[snapshot.months.length - 1];
  if (!today || !yesterday || !thisMonth) return null;

  const current = metricValue(today);
  const previous = metricValue(yesterday);
  const change = delta(current, previous);

  // 昨日为 0 时算不出百分比，也就没有涨跌语义：这时不给箭头与强调色，
  // 否则「↑ 昨日无数据」会读成「涨了」。
  let deltaText: string;
  let deltaTone: 'up' | 'down' | 'flat';
  if (change.percent === null) {
    deltaText = current > 0 ? '昨日无数据' : '与昨日持平';
    deltaTone = 'flat';
  } else {
    deltaText = `较昨日 ${change.percent > 0 ? '+' : ''}${change.percent}%`;
    deltaTone = change.direction;
  }

  return {
    today: formatMetric(current),
    yesterday: formatMetric(previous),
    month: formatMetric(metricValue(thisMonth)),
    deltaText,
    deltaTone,
    /** 今日读数本身：请求量口径下顺带给出成功/失败 */
    todayDetail:
      trendMetric.value === 'requests'
        ? `成功 ${num(today.success)} · 失败 ${num(today.error)}`
        : `${num(today.total)} 次请求`,
  };
});

// ── 明细表（按日 / 按月）──────────────────────────────────────────────────

interface UsageRow {
  key: string;
  label: string;
  total: number;
  success: number;
  error: number;
  durationSumMs: number;
  tokens: number;
  credit: number;
}

function toRows(): UsageRow[] {
  const snapshot = history.value;
  if (!snapshot) return [];
  const map = (key: string, label: string, bucket: MetricTotals): UsageRow => ({
    key,
    label,
    total: bucket.total,
    success: bucket.success,
    error: bucket.error,
    durationSumMs: bucket.durationSumMs,
    tokens: tokensOf(bucket),
    credit: bucket.credit,
  });
  if (trendGrain.value === 'month') {
    // 表格按时间倒序：最近的在最上面，运维查的是「刚才怎么样」
    return snapshot.months
      .map((item) => map(item.month, fmtMonthLabel(item.month), item))
      .reverse();
  }
  return snapshot.days.map((item) => map(item.day, fmtDayLabel(item.day), item)).reverse();
}

const usageRows = computed(toRows);

const usageColumns: DataTableColumns<UsageRow> = [
  { title: '区间', key: 'label', width: 120, render: (row) => h('span', { class: 'tnum' }, row.label) },
  { title: '请求', key: 'total', width: 100, align: 'right', render: (row) => h('span', { class: 'tnum' }, num(row.total)) },
  {
    title: '成功率',
    key: 'success',
    width: 110,
    align: 'right',
    render: (row) => {
      if (row.total === 0) return h('span', { class: 'sub' }, '—');
      const value = Math.round((row.success / row.total) * 1000) / 10;
      const tone = value >= 99 ? 'good' : value >= 95 ? 'warn' : 'bad';
      return h('span', { class: `tnum ${tone}` }, `${value}%`);
    },
  },
  {
    title: '失败',
    key: 'error',
    width: 88,
    align: 'right',
    render: (row) => (row.error > 0 ? h('span', { class: 'tnum bad' }, num(row.error)) : h('span', { class: 'sub' }, '0')),
  },
  {
    title: '平均耗时',
    key: 'durationSumMs',
    width: 110,
    align: 'right',
    render: (row) => h('span', { class: 'tnum' }, row.total ? fmtMs(row.durationSumMs / row.total) : '—'),
  },
  {
    title: 'Token',
    key: 'tokens',
    width: 110,
    align: 'right',
    render: (row) => h('span', { class: 'tnum' }, row.tokens > 0 ? fmtTokens(row.tokens) : '—'),
  },
  {
    title: '积分',
    key: 'credit',
    width: 100,
    align: 'right',
    // 积分为 0 是有效值(免费模型),与「未上报」不是一回事
    render: (row) => h('span', { class: 'tnum' }, row.credit > 0 ? fmtCredit(row.credit) : '0'),
  },
];

/**
 * 合计行：请求量、Token、积分可加；成功率与平均耗时由合计值重新算出，
 * 而不是把各行的百分比求平均（那样会被小样本区间带偏）。
 *
 * 单元格形状由 Naive UI 规定为 `{ value }`，键名与列的 key 一一对应。
 */
function usageSummaryRow(): Record<string, { value: string }> {
  const rows = usageRows.value;
  let total = 0;
  let success = 0;
  let error = 0;
  let durationSumMs = 0;
  let tokens = 0;
  let credit = 0;
  for (const row of rows) {
    total += row.total;
    success += row.success;
    error += row.error;
    durationSumMs += row.durationSumMs;
    tokens += row.tokens;
    credit += row.credit;
  }
  return {
    label: { value: '合计' },
    total: { value: num(total) },
    success: { value: total ? `${Math.round((success / total) * 1000) / 10}%` : '—' },
    error: { value: num(error) },
    durationSumMs: { value: total ? fmtMs(durationSumMs / total) : '—' },
    tokens: { value: fmtTokens(tokens) },
    credit: { value: fmtCredit(credit) },
  };
}

/** 导出 CSV：BOM 前缀让 Excel 正确识别 UTF-8 中文表头 */
function exportCsv(): void {
  const rows = usageRows.value;
  if (rows.length === 0) return;

  const header = ['区间', '请求', '成功', '失败', '平均耗时(ms)', 'Token', '积分'];
  const body = rows.map((row) => [
    row.label,
    row.total,
    row.success,
    row.error,
    row.total ? Math.round(row.durationSumMs / row.total) : 0,
    row.tokens,
    row.credit,
  ]);
  const csv = [header, ...body].map((line) => line.join(',')).join('\r\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gateway-usage-${trendGrain.value === 'month' ? 'monthly' : 'daily'}-${Date.now()}.csv`;
  anchor.click();
  URL.revokeObjectURL(url);
  message.success(`已导出 ${rows.length} 行`);
}

// ── 明细层 ────────────────────────────────────────────────────────────────

/** 最近请求列定义：状态与耗时是最常扫的两列，放中间；凭证放最后并支持悬停看全名 */
const recentColumns: DataTableColumns<RequestRecord> = [
  { title: '时间', key: 'at', width: 92, render: (row) => h('span', { class: 'mono tnum' }, fmtClock(row.at)) },
  { title: '接口', key: 'path', width: 176, render: (row) => h('span', { class: 'mono' }, row.path) },
  { title: '模型', key: 'model', minWidth: 140, render: (row) => h('span', { class: 'mono' }, row.model || '—') },
  {
    title: '状态',
    key: 'status',
    width: 86,
    render: (row) =>
      h(
        NTag,
        { size: 'small', bordered: false, type: row.status < 400 ? 'success' : row.status >= 500 ? 'error' : 'warning' },
        { default: () => String(row.status) },
      ),
  },
  { title: '耗时', key: 'durationMs', width: 88, align: 'right', render: (row) => h('span', { class: 'tnum' }, fmtMs(row.durationMs)) },
  {
    title: 'Token',
    key: 'totalTokens',
    width: 96,
    align: 'right',
    render: (row) => h('span', { class: 'tnum' }, row.totalTokens ? fmtTokens(row.totalTokens) : '—'),
  },
  {
    title: '积分',
    key: 'credit',
    width: 88,
    align: 'right',
    render: (row) => h('span', { class: 'tnum' }, row.credit !== undefined ? fmtCredit(row.credit) : '未上报'),
  },
  {
    title: '凭证',
    key: 'credentialName',
    width: 150,
    render: (row) =>
      h(
        NTooltip,
        { trigger: 'hover' },
        {
          trigger: () =>
            h(
              'span',
              { class: 'mono sub' },
              row.credentialName || row.credentialId || (row.retried ? '已故障转移' : '—'),
            ),
          default: () =>
            row.retried
              ? '该请求发生凭证故障转移后成功'
              : row.credentialName
                ? `${row.credentialName}（${row.credentialId ?? ''}）`
                : '未使用托管凭证（透传）',
        },
      ),
  },
];
</script>

<template>
  <div class="page stack">
    <PageHeader title="总览" desc="实时口径为本进程最近 60 分钟；日/月归档持久化保存，重启后仍可回溯">
      <NButton secondary :loading="loading" @click="refresh">
        <template #icon><AppIcon name="refresh" :size="15" /></template>
        刷新
      </NButton>
    </PageHeader>

    <!-- ① 健康横幅：一眼看清服务与凭证池状态 -->
    <div class="banner">
      <div class="banner-main">
        <span class="pulse" />
        <div>
          <div class="banner-title">网关运行中</div>
          <div class="sub">
            已运行 {{ fmtDuration(metrics?.uptime.uptimeMs) }}
            <template v-if="store.state"> · 存储 {{ store.state.storage === 'persistent' ? 'SQLite 持久化' : '内存' }}</template>
          </div>
        </div>
      </div>
      <div class="banner-side">
        <NTag v-if="health" :type="health.type" :bordered="false" size="small">{{ health.text }}</NTag>
        <NTag v-if="counts" :bordered="false" size="small">{{ counts.keys }} 个客户端 Key</NTag>
        <NButton v-if="counts && counts.credentials === 0" type="primary" size="small" @click="navigate('credentials')">
          添加上游凭证
        </NButton>
      </div>
    </div>

    <!-- ② 实时 KPI：4 张主指标，权重一致，趋势线作为背景佐证 -->
    <section class="kpis" aria-label="实时指标">
      <StatCard
        label="请求速率"
        :value="num(totals?.lastMinute ?? 0)"
        unit="/min"
        :hint="`最近 60 分钟 ${num(totals?.total ?? 0)} 次`"
        icon="zap"
        :trend="requestTrend"
      />
      <StatCard
        label="成功率"
        :value="totals?.total ? String(totals.successRate) : '—'"
        unit="%"
        :hint="`失败 ${num(totals?.error ?? 0)} 次`"
        icon="check"
        :tone="successTone"
        :trend="errorTrend"
      />
      <StatCard
        label="P95 耗时"
        :value="fmtMs(totals?.p95Ms)"
        :hint="`P50 ${fmtMs(totals?.p50Ms)} · P99 ${fmtMs(totals?.p99Ms)}`"
        icon="gauge"
        :tone="(totals?.p95Ms ?? 0) > 30_000 ? 'warn' : 'default'"
        :trend="latencyTrend"
      />
      <StatCard
        label="Token 速率"
        :value="totals ? fmtTokens(totals.avgTokensPerMinute) : '—'"
        unit="/min"
        :hint="tokenCoverage"
        icon="activity"
        tone="info"
        :trend="tokenTrend"
      />
    </section>

    <!-- ③ 实时流量时序 -->
    <section class="panel" aria-label="实时流量">
      <div class="panel-head">
        <div class="panel-title">
          流量时序
          <span class="sub">最近 60 分钟</span>
        </div>
        <div class="panel-head-extra legend">
          <span><i class="swatch ok" />成功</span>
          <span><i class="swatch bad" />失败</span>
        </div>
      </div>
      <div class="panel-body">
        <TrafficChart :series="metrics?.series ?? []" />
      </div>
    </section>

    <!-- ④ 归档层：按日 / 按月的用量统计 -->
    <section class="panel" aria-label="用量统计">
      <div class="panel-head">
        <div class="panel-title">
          <AppIcon name="calendar" :size="15" />
          用量统计
          <span class="sub">{{ trendGrain === 'month' ? `最近 ${MONTH_RANGE} 个月` : `最近 ${DAY_RANGE} 天` }}</span>
        </div>
        <div class="panel-head-extra">
          <SegmentedControl
            v-model="trendMetric"
            label="度量"
            :options="[
              { value: 'requests', label: '请求量' },
              { value: 'tokens', label: 'Token' },
              { value: 'credit', label: '积分' },
            ]"
          />
          <SegmentedControl
            v-model="trendGrain"
            label="粒度"
            :options="[
              { value: 'day', label: '按日' },
              { value: 'month', label: '按月' },
            ]"
          />
          <NButton quaternary size="small" :disabled="usageRows.length === 0" @click="exportCsv">
            <template #icon><AppIcon name="download" :size="14" /></template>
            导出
          </NButton>
        </div>
      </div>

      <div v-if="!archiveEnabled" class="panel-body">
        <EmptyState
          icon="database"
          title="日/月归档未启用"
          desc="归档需要持久化存储。当前进程使用内存存储（未配置 DATA_FILE 或 CREDENTIALS_KV），重启后历史无法保留。"
        />
      </div>

      <template v-else>
        <!-- 摘要条：跟随度量切换，读数始终与图表同口径 -->
        <div v-if="usageSummary" class="summary">
          <div class="summary-item">
            <span class="summary-label">今日{{ metricLabel }}</span>
            <b class="summary-value tnum">{{ usageSummary.today }}</b>
            <span class="summary-hint">{{ usageSummary.todayDetail }}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">昨日{{ metricLabel }}</span>
            <b class="summary-value tnum muted">{{ usageSummary.yesterday }}</b>
            <span class="summary-hint" :class="usageSummary.deltaTone">
              <AppIcon
                v-if="usageSummary.deltaTone !== 'flat'"
                :name="usageSummary.deltaTone === 'up' ? 'arrow-up' : 'arrow-down'"
                :size="12"
              />
              {{ usageSummary.deltaText }}
            </span>
          </div>
          <div class="summary-item">
            <span class="summary-label">本月{{ metricLabel }}</span>
            <b class="summary-value tnum">{{ usageSummary.month }}</b>
            <span class="summary-hint">按自然月累计</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">积分消耗（本月）</span>
            <b class="summary-value tnum">{{ fmtCredit(history?.months[history.months.length - 1]?.credit) }}</b>
            <span class="summary-hint">上游未上报积分的不计入</span>
          </div>
        </div>

        <div class="panel-body">
          <TrendBars
            :items="trendPoints"
            :metric="trendMetric"
            :empty-hint="trendGrain === 'month' ? '最近 12 个月暂无请求' : '最近 30 天暂无请求'"
          />
        </div>

        <div class="table-toggle">
          <NButton quaternary size="tiny" @click="showTable = !showTable">
            <template #icon><AppIcon :name="showTable ? 'arrow-up' : 'arrow-down'" :size="13" /></template>
            {{ showTable ? '收起明细' : '查看明细' }}
          </NButton>
          <span class="sub">共 {{ usageRows.length }} 行</span>
        </div>

        <div v-if="showTable" class="table-wrap">
          <NDataTable
            :columns="usageColumns"
            :data="usageRows"
            :bordered="false"
            :single-line="false"
            size="small"
            :scroll-x="740"
            :pagination="{ pageSize: 15 }"
            :summary="usageSummaryRow"
          >
            <template #empty>
              <EmptyState icon="calendar" title="暂无归档数据" desc="网关处理请求后，这里会按自然日累积。" />
            </template>
          </NDataTable>
        </div>
      </template>
    </section>

    <!-- ⑤ 分布 -->
    <div class="grid-auto">
      <BreakdownList title="按模型" :stats="metrics?.byModel ?? []" empty-hint="暂无请求记录" />
      <BreakdownList title="按接口" :stats="metrics?.byPath ?? []" empty-hint="暂无请求记录" />
    </div>

    <!-- ⑥ 明细 -->
    <div class="grid-auto">
      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">近期错误</div>
          <div class="panel-head-extra">
            <NButton quaternary size="tiny" @click="navigate('logs')">查看全部日志</NButton>
          </div>
        </div>
        <div class="panel-body">
          <div v-if="(metrics?.recentErrors ?? []).length === 0" class="all-good">
            <AppIcon name="check" :size="15" />
            <span>最近 {{ num(metrics?.recent.length ?? 0) }} 次请求均成功</span>
          </div>
          <ul v-else class="errors">
            <li v-for="item in metrics?.recentErrors ?? []" :key="item.at + item.path">
              <span class="mono tnum time">{{ fmtClock(item.at) }}</span>
              <NTag size="small" :bordered="false" :type="item.status >= 500 ? 'error' : 'warning'">{{ item.status }}</NTag>
              <span class="mono path">{{ item.path }}</span>
              <span class="msg">{{ item.error || '上游返回错误' }}</span>
            </li>
          </ul>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head">
          <div class="panel-title">最近请求</div>
          <div class="panel-head-extra">
            <span class="sub">共 {{ num(metrics?.recent.length ?? 0) }} 条明细</span>
          </div>
        </div>
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
            <EmptyState icon="activity" title="暂无请求记录" desc="客户端调用网关后，这里会显示接口、模型、状态与耗时。" />
          </template>
        </NDataTable>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* ── 健康横幅 ── */
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px 18px;
  background: linear-gradient(90deg, var(--accent-soft), transparent 58%), var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
}

.banner-main {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.banner-title {
  font-size: 14.5px;
  font-weight: 600;
}

.banner-side {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.pulse {
  width: 10px;
  height: 10px;
  flex: none;
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
    box-shadow: 0 0 0 9px transparent;
  }
}

/* ── 实时 KPI ── */
.kpis {
  display: grid;
  gap: 12px;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
}

/* ── 图例 ── */
.legend {
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

/* ── 用量摘要条 ── */
.summary {
  display: grid;
  gap: 1px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  background: var(--border-soft);
  border-bottom: 1px solid var(--border-soft);
}

.summary-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 13px 16px;
  background: var(--surface);
}

.summary-label {
  font-size: 11.5px;
  color: var(--text-3);
}

.summary-value {
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.2;
}

.summary-value.muted {
  color: var(--text-2);
  font-weight: 600;
}

.summary-hint {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11.5px;
  color: var(--text-3);
}

.summary-hint.up {
  color: var(--accent);
}

.summary-hint.down {
  color: var(--text-2);
}

/* ── 明细表折叠 ── */
.table-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 16px 12px;
}

.table-wrap {
  border-top: 1px solid var(--border-soft);
}

/* ── 错误与成功态 ── */
.all-good {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 2px;
  color: var(--accent);
  font-size: 13px;
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

@media (max-width: 720px) {
  .banner {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
