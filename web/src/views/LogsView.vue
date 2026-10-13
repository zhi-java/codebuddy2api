<script setup lang="ts">
/**
 * 日志：live tail 形态的运行事件流。
 *
 * ── 极简口径下与上一版的差别 ────────────────────────────────────────
 * 从「四列表格」改为「日志流」。理由：日志的本质是**读句子**，不是比字段。
 * 表格强制每列等宽且不换行，长 message 会被截断，而它恰恰是最该读全的部分。
 * 改成流式后，时间与级别靠左固定宽度，说明独占一行并允许折行。
 *
 * 保留全部能力：
 *   - 暂停后仍在后台累积，恢复时补齐（避免抖动时丢事件）；
 *   - 级别多选（带计数）+ 关键词过滤（服务端过滤，减少传输）；
 *   - 结构化字段直接展示在说明下方（不再需要展开动作）；
 *   - 可导出当前结果、可复制单条用于贴工单。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { NButton, NInput, useMessage } from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import TableSkeleton from '../components/TableSkeleton.vue';
import { api, type DataResponse } from '../api';
import { tick } from '../autoRefresh';
import { useCopy } from '../clipboard';
import { fmtClock } from '../format';
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

/** 级别多选：至少保留一个，否则列表会空掉且用户不知道为什么 */
function toggleLevel(level: LogLevel): void {
  if (levels.value.includes(level)) {
    if (levels.value.length === 1) return;
    levels.value = levels.value.filter((item) => item !== level);
  } else {
    levels.value = [...levels.value, level];
  }
}

const levelCount = computed(() => {
  const counts: Record<string, number> = { info: 0, warn: 0, error: 0 };
  for (const entry of held.value) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
  return counts;
});

/** 结构化字段渲染成 `k=v` 一行，比可折叠面板少一次交互 */
function fieldsOf(entry: LogEntry): string {
  if (!entry.data || !Object.keys(entry.data).length) return '';
  return Object.entries(entry.data)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join('  ');
}

watch(tick, () => void load());
watch(levels, () => void load());
watch(keyword, () => void load());

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="日志" desc="上游失败、凭证切换、定时签到等事件（进程内最近 300 条，重启即清零）">
      <NButton :secondary="!paused" :type="paused ? 'warning' : 'default'" @click="togglePause">
        <template #icon><AppIcon :name="paused ? 'play' : 'pause'" :size="14" /></template>
        {{ paused ? '恢复' : '暂停' }}
      </NButton>
      <NButton secondary :loading="loading" @click="load">
        <template #icon><AppIcon name="refresh" :size="14" /></template>
        刷新
      </NButton>
      <NButton secondary :disabled="logs.length === 0" @click="exportLogs">
        <template #icon><AppIcon name="download" :size="14" /></template>
        导出
      </NButton>
    </PageHeader>

    <!-- 筛选行：级别 + 搜索。级别用下划线表示选中，与全站一致 -->
    <div class="filters">
      <div class="seg" role="group" aria-label="日志级别筛选">
        <button
          v-for="level in (['info', 'warn', 'error'] as LogLevel[])"
          :key="level"
          type="button"
          :class="{ on: levels.includes(level) }"
          :aria-pressed="levels.includes(level)"
          @click="toggleLevel(level)"
        >
          {{ level.toUpperCase() }}
          <span class="n">{{ levelCount[level] ?? 0 }}</span>
        </button>
      </div>

      <NInput v-model:value="keyword" placeholder="搜索事件、说明或字段值" clearable size="small" style="width: 280px">
        <template #prefix><AppIcon name="search" :size="14" /></template>
      </NInput>

      <span class="sub">共 {{ logs.length }} 条</span>

      <NButton v-if="logs.length > 0" quaternary size="tiny" style="margin-left: auto" @click="clearLocal">
        清空显示
      </NButton>
    </div>

    <div v-if="paused" class="note warn">已暂停显示（事件仍在后台累积，点「恢复」查看最新）。</div>

    <!-- 首屏骨架：暂停时不显示（暂停本身意味着用户要留住当前内容） -->
    <TableSkeleton v-if="!loaded && !paused" :widths="[0.6, 0.5, 3]" :rows="8" />

    <div v-else-if="logs.length === 0">
      <EmptyState
        icon="logs"
        title="暂无日志"
        desc="上游失败、凭证切换或定时签到发生后，事件显示在这里。"
      />
    </div>

    <div v-else class="stream" :class="{ veiled: paused }">
      <div v-for="(entry, index) in logs" :key="entry.at + '-' + index" class="logline">
        <span class="t tnum">{{ fmtClock(entry.at) }}</span>
        <span class="lv" :class="entry.level">{{ entry.level.toUpperCase() }}</span>
        <div class="body">
          <div class="msg">
            {{ entry.message }}
            <span class="sub">{{ entry.event }}</span>
          </div>
          <div v-if="fieldsOf(entry)" class="fields">{{ fieldsOf(entry) }}</div>
        </div>
        <button class="copy" type="button" title="复制该条日志的 JSON" @click="copyLine(entry)">
          <AppIcon name="copy" :size="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

/* 级别筛选：下划线选中态，数字用等宽 */
/* 窄屏下级别项可能放不下，允许横向滚动而非折行（折行会断开下划线选中态） */
.seg {
  display: flex;
  gap: 18px;
  border-bottom: 1px solid var(--line);
  overflow-x: auto;
  scrollbar-width: none;
}

.seg::-webkit-scrollbar {
  display: none;
}

.seg button {
  position: relative;
  border: none;
  background: transparent;
  padding: 0 0 9px;
  font-size: 12.5px;
  font-weight: 550;
  color: var(--text-3);
  font-family: var(--mono);
  transition: color var(--dur) var(--ease);
}

.seg button:hover {
  color: var(--text);
}

.seg button.on {
  color: var(--text);
  font-weight: 620;
}

.seg button.on::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 2px;
  background: var(--text);
}

.seg .n {
  margin-left: 6px;
  font-size: 11.5px;
  color: var(--text-3);
}

/* ── 日志流 ──
   时间与级别固定宽度，说明独占一行并允许折行 —— 日志是读句子，不是比字段。 */
.stream {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
}

.stream.veiled {
  opacity: 0.5;
}

.logline {
  display: flex;
  gap: 14px;
  align-items: baseline;
  padding: 9px 0;
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
  line-height: 1.65;
}

.logline:last-child {
  border-bottom: none;
}

.logline:hover {
  background: rgba(0, 0, 0, 0.014);
}

.t {
  flex: none;
  width: 62px;
  color: var(--text-3);
  font-family: var(--mono);
  font-size: 11.5px;
}

.lv {
  flex: none;
  width: 44px;
  font-family: var(--mono);
  font-size: 10.5px;
  font-weight: 640;
  letter-spacing: 0.05em;
  color: var(--text-3);
}

.lv.warn {
  color: var(--warn);
}

.lv.error {
  color: var(--bad);
}

.body {
  flex: 1;
  min-width: 0;
}

.msg {
  color: var(--text);
}

.fields {
  margin-top: 5px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  word-break: break-all;
}

/* 复制按钮默认隐形，悬停浮现 —— 避免每行都挂一个按钮把流读散 */
.copy {
  flex: none;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  opacity: 0;
  transition: opacity 140ms var(--ease), color 140ms var(--ease);
}

.logline:hover .copy,
.copy:focus-visible {
  opacity: 1;
}

.copy:hover {
  color: var(--accent);
}
</style>
