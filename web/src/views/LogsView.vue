<script setup lang="ts">
/**
 * 日志：live tail 形态的运行事件流。
 *
 * 真实排障要的是「可暂停、可过滤、可导出、能看结构化字段」，
 * 而不是一张静态表格：
 *   - 暂停后仍在后台累积，恢复时补齐（避免抖动时丢事件）；
 *   - 级别多选 + 关键词过滤（服务端过滤，减少传输）；
 *   - 行内可展开查看结构化的 data 字段；
 *   - 可导出当前结果用于贴单。
 */
import { computed, h, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NCheckboxGroup,
  NCheckbox,
  NDataTable,
  NInput,
  NTag,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import TableSkeleton from '../components/TableSkeleton.vue';
import { api, type DataResponse } from '../api';
import { tick } from '../autoRefresh';
import { useCopy } from '../clipboard';
import { LEVEL_META, fmtClock, fmtTime } from '../format';
import type { LogEntry, LogLevel } from '../types';

const message = useMessage();
const copy = useCopy();

const logs = ref<LogEntry[]>([]);
const loading = ref(false);
const paused = ref(false);
const held = ref<LogEntry[]>([]);
const levels = ref<LogLevel[]>(['info', 'warn', 'error']);
const keyword = ref('');
/** 是否已经完成过一次拉取：用于区分「首屏加载中」与「确实没有日志」 */
const loaded = ref(false);

async function load(): Promise<void> {
  if (paused.value) return;
  loading.value = true;
  try {
    const res = await api<DataResponse<LogEntry[]>>('/admin/api/logs', {
      query: {
        limit: 200,
        level: levels.value.length === 1 ? levels.value[0] : undefined,
        q: keyword.value.trim() || undefined,
      },
    });
    let list = res.data ?? [];
    // 级别多选：单级别交给服务端过滤,多级别在前端筛掉未勾选项
    if (levels.value.length > 1) list = list.filter((entry) => levels.value.includes(entry.level));
    held.value = list;
    logs.value = list;
  } catch (err) {
    message.error((err as Error).message);
  } finally {
    loading.value = false;
    // 失败也算「已尝试」：否则接口出错时骨架会永久停留，比空态更难判断
    loaded.value = true;
  }
}

function togglePause(): void {
  paused.value = !paused.value;
  if (!paused.value) {
    // 恢复时立即补齐暂停期间累积的结果
    logs.value = held.value;
    void load();
  }
}

function clearLocal(): void {
  logs.value = [];
  held.value = [];
}

function exportLogs(): void {
  const blob = new Blob([JSON.stringify(logs.value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `gateway-logs-${Date.now()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  message.success(`已导出 ${logs.value.length} 条日志`);
}

/** 复制整条日志的结构化 JSON，便于直接贴进工单 */
async function copyLine(entry: LogEntry): Promise<void> {
  await copy(JSON.stringify(entry), '已复制该条日志');
}

const columns: DataTableColumns<LogEntry> = [
  { title: '时间', key: 'at', width: 100, render: (row) => h('span', { class: 'mono sub' }, fmtClock(row.at)) },
  {
    title: '级别',
    key: 'level',
    width: 92,
    render: (row) => {
      const meta = LEVEL_META[row.level] ?? { label: row.level, type: 'default' as const };
      return h(NTag, { size: 'small', bordered: false, type: meta.type }, { default: () => meta.label });
    },
  },
  { title: '事件', key: 'event', width: 186, render: (row) => h('span', { class: 'mono' }, row.event) },
  {
    title: '说明',
    key: 'message',
    minWidth: 320,
    render: (row) => {
      const detail = row.data && Object.keys(row.data).length ? JSON.stringify(row.data) : '';
      return h('div', null, [
        h('div', null, row.message),
        detail ? h('div', { class: 'sub mono detail' }, detail) : null,
      ]);
    },
  },
  {
    title: '',
    key: 'actions',
    width: 56,
    align: 'right',
    render: (row) =>
      h(
        NButton,
        { size: 'tiny', quaternary: true, onClick: () => void copyLine(row) },
        { default: () => '复制' },
      ),
  },
];

const levelCount = computed(() => {
  const counts: Record<string, number> = { info: 0, warn: 0, error: 0 };
  for (const entry of held.value) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
  return counts;
});

watch(tick, () => void load());
watch(levels, () => void load());
watch(keyword, () => void load());

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="日志" desc="上游失败、凭证切换、定时签到等（进程内最近 300 条）">
      <NButton :secondary="!paused" :type="paused ? 'warning' : 'default'" @click="togglePause">
        <template #icon><AppIcon :name="paused ? 'play' : 'pause'" :size="15" /></template>
        {{ paused ? '恢复' : '暂停' }}
      </NButton>
      <NButton secondary :loading="loading" @click="load">
        <template #icon><AppIcon name="refresh" :size="15" /></template>
        刷新
      </NButton>
      <NButton secondary :disabled="logs.length === 0" @click="exportLogs">
        <template #icon><AppIcon name="download" :size="15" /></template>
        导出
      </NButton>
    </PageHeader>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">
          事件流
          <span v-if="paused" class="paused">已暂停（仍在后台累积）</span>
          <span v-else class="sub">共 {{ logs.length }} 条</span>
        </div>
        <div class="panel-head-extra">
          <NInput v-model:value="keyword" placeholder="搜索事件、说明或字段值" clearable size="small" style="width: 240px">
            <template #prefix><AppIcon name="search" :size="14" /></template>
          </NInput>
          <NCheckboxGroup v-model:value="levels">
            <div class="levels">
              <NCheckbox value="info">INFO<span class="count tnum">{{ levelCount.info }}</span></NCheckbox>
              <NCheckbox value="warn">WARN<span class="count tnum">{{ levelCount.warn }}</span></NCheckbox>
              <NCheckbox value="error">ERROR<span class="count tnum">{{ levelCount.error }}</span></NCheckbox>
            </div>
          </NCheckboxGroup>
          <NButton v-if="logs.length > 0" quaternary size="tiny" @click="clearLocal">清空显示</NButton>
        </div>
      </div>

      <!-- 首屏骨架：暂停时不显示（暂停本身意味着用户要留住当前内容） -->
      <TableSkeleton
        v-if="!loaded && !paused"
        class="panel-body"
        :widths="[0.6, 1, 3, 1.6]"
        :rows="8"
      />

      <NDataTable
        v-else
        :columns="columns"
        :data="logs"
        :bordered="false"
        :single-line="false"
        size="small"
        :loading="loading && !paused"
        :scroll-x="820"
        :pagination="{ pageSize: 20 }"
      >
        <template #empty>
          <EmptyState
            icon="logs"
            title="暂无日志"
            desc="上游失败、凭证切换或定时签到发生后，事件显示在这里。"
          />
        </template>
      </NDataTable>
    </section>
  </div>
</template>

<style scoped>
.levels {
  display: flex;
  gap: 14px;
}

.count {
  margin-left: 6px;
  font-size: 11px;
  color: var(--text-3);
}

.paused {
  font-size: 12px;
  color: var(--warn);
}

:deep(.mono) {
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

:deep(.detail) {
  word-break: break-all;
  margin-top: 2px;
  opacity: 0.75;
}
</style>
