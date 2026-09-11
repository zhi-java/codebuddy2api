<script setup lang="ts">
/**
 * 一组横向占比条：用于「按模型 / 按接口」的请求量分布。
 *
 * 用条形长度表达占比，同时显示原始次数——不单靠颜色传达信息。
 */
import { computed } from 'vue';
import { fmtTokens } from '../format';
import type { GroupStat } from '../types';

const props = defineProps<{ title: string; stats: GroupStat[]; emptyHint?: string }>();

const max = computed(() => Math.max(1, ...props.stats.map((item) => item.total)));

function errorRate(stat: GroupStat): number {
  return stat.total ? Math.round((stat.errors / stat.total) * 100) : 0;
}
</script>

<template>
  <div class="panel">
    <div class="panel-head">
      <h3>{{ title }}</h3>
    </div>
    <div v-if="stats.length === 0" class="empty">{{ emptyHint ?? '暂无数据' }}</div>
    <ul v-else class="list">
      <li v-for="stat in stats" :key="stat.key">
        <div class="row">
          <span class="key mono" :title="stat.key">{{ stat.key }}</span>
          <span class="count">{{ stat.total }}</span>
        </div>
        <div class="track">
          <div class="fill" :style="{ width: (stat.total / max) * 100 + '%' }" />
        </div>
        <div class="meta">
          <span>平均 {{ stat.avgDurationMs }} ms</span>
          <span v-if="stat.totalTokens > 0">{{ fmtTokens(stat.totalTokens) }} tokens</span>
          <span v-if="stat.errors > 0" class="bad">失败 {{ stat.errors }}（{{ errorRate(stat) }}%）</span>
          <span v-else class="ok">无失败</span>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.panel {
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 14px 16px 16px;
}

.panel-head h3 {
  margin: 0 0 12px;
  font-size: 13.5px;
  font-weight: 600;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

.key {
  font-size: 12.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-variant-numeric: tabular-nums;
  font-size: 12.5px;
  color: var(--text-2);
}

.track {
  height: 5px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
  margin: 6px 0 5px;
}

.fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--accent), rgba(34, 197, 94, 0.55));
  transition: width 320ms var(--ease);
}

.meta {
  display: flex;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-3);
}

.bad {
  color: var(--danger);
}

.ok {
  color: var(--text-3);
}

.empty {
  color: var(--text-3);
  font-size: 12.5px;
  padding: 18px 0;
  text-align: center;
}
</style>
