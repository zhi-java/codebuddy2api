<script setup lang="ts">
/**
 * 一组横向占比条：用于「按模型 / 按接口」的请求量分布。
 *
 * 极简口径：条压到 2px、去掉圆角与渐变（渐变是装饰，不承载信息），
 * 用长度 + 原始数字双重表达占比 —— 不单靠颜色传达信息。
 */
import { computed } from 'vue';
import { NSkeleton } from 'naive-ui';
import { fmtTokens } from '../format';
import type { GroupStat } from '../types';

const props = defineProps<{
  title: string;
  stats: GroupStat[];
  emptyHint?: string;
  /** 首屏数据未到：渲染骨架而非「暂无数据」，避免把加载中误报成空 */
  loading?: boolean;
}>();

const max = computed(() => Math.max(1, ...props.stats.map((item) => item.total)));

function errorRate(stat: GroupStat): number {
  return stat.total ? Math.round((stat.errors / stat.total) * 100) : 0;
}
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <div class="panel-title">
        {{ title }}
        <span class="sub">最近 200 条请求</span>
      </div>
    </div>

    <ul v-if="loading" class="list" aria-busy="true" aria-label="加载中">
      <li v-for="i in 3" :key="i">
        <NSkeleton text :sharp="false" width="55%" height="12px" />
        <NSkeleton text :sharp="false" width="100%" height="2px" style="margin-top: 10px" />
      </li>
    </ul>

    <div v-else-if="stats.length === 0" class="empty">{{ emptyHint ?? '暂无数据' }}</div>

    <ul v-else class="list">
      <li v-for="stat in stats" :key="stat.key">
        <div class="row">
          <span class="key mono" :title="stat.key">{{ stat.key }}</span>
          <span class="count tnum">{{ stat.total.toLocaleString('en-US') }}</span>
        </div>
        <div class="track">
          <div class="fill" :style="{ width: (stat.total / max) * 100 + '%' }" />
        </div>
        <div class="meta">
          <span>平均 {{ stat.avgDurationMs }} ms</span>
          <span v-if="stat.totalTokens > 0">{{ fmtTokens(stat.totalTokens) }} tokens</span>
          <span v-if="stat.errors > 0" class="bad">失败 {{ stat.errors }}（{{ errorRate(stat) }}%）</span>
          <span v-else>无失败</span>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.key {
  font-size: 12.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.count {
  font-size: 12.5px;
  font-weight: 600;
  flex: none;
}

/* 2px 细线：占比条只需要表达比例，不需要视觉重量 */
.track {
  height: 2px;
  background: var(--line);
  overflow: hidden;
  margin: 9px 0 8px;
}

.fill {
  height: 100%;
  background: var(--text);
  transition: width 480ms var(--ease);
}

.meta {
  display: flex;
  gap: 14px;
  font-size: 11.5px;
  color: var(--text-3);
}

.bad {
  color: var(--bad);
}

.empty {
  color: var(--text-3);
  font-size: 12.5px;
  padding: 24px 0;
}
</style>
