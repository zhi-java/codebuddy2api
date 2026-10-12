<script setup lang="ts">
/**
 * 读数（KPI）。
 *
 * 极简口径：**不做卡片**。上一版是「白卡 + 阴影 + 图标块 + 趋势线 + 边框」，
 * 四张并排时视觉噪音远大于信息量。现在只保留「标签 / 读数 / 一行说明 / 细趋势线」，
 * 由父容器用发丝竖线分隔（见 styles.css 的 .stats / .stat）。
 *
 * 趋势线是**佐证**而非主体：它回答「这个读数是涨还是跌」，故压到 24px 高、
 * 用极淡填充，不与读数争夺注意力。
 */
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    unit?: string;
    hint?: string;
    /** 状态色调：只影响读数颜色，不做背景块 */
    tone?: 'default' | 'good' | 'warn' | 'bad' | 'info';
    /** 迷你趋势序列 */
    trend?: number[];
    /** 趋势线颜色；缺省跟随 tone */
    trendColor?: string;
  }>(),
  { tone: 'default', trend: () => [] },
);

const toneClass = computed(() => (props.tone === 'default' ? '' : props.tone));

/** 迷你趋势：细折线 + 极淡填充。数据点不足 2 个时不画。 */
const trendPath = computed(() => {
  const values = props.trend;
  if (values.length < 2) return null;
  const w = 240;
  const h = 24;
  const pad = 2;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - pad - ((v - min) / span) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return { line: `M${pts.join('L')}`, area: `M${pts.join('L')}L${w},${h}L0,${h}Z`, w, h };
});

const lineColor = computed(() => {
  if (props.trendColor) return props.trendColor;
  return (
    { good: 'var(--ok)', warn: 'var(--warn)', bad: 'var(--bad)', info: 'var(--accent)' }[
      props.tone as string
    ] ?? 'var(--text-3)'
  );
});
</script>

<template>
  <div class="stat">
    <div class="stat-k label">{{ label }}</div>
    <div class="stat-v" :class="toneClass">
      {{ value }}<small v-if="unit">{{ unit }}</small>
    </div>
    <div v-if="hint" class="stat-d">{{ hint }}</div>
    <svg
      v-if="trendPath"
      class="spark"
      :viewBox="`0 0 ${trendPath.w} ${trendPath.h}`"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path :d="trendPath.area" :fill="lineColor" opacity="0.07" />
      <path
        :d="trendPath.line"
        fill="none"
        :stroke="lineColor"
        stroke-width="1.3"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  </div>
</template>

<style scoped>
.spark {
  width: 100%;
  height: 24px;
  display: block;
  margin-top: 12px;
}
</style>
