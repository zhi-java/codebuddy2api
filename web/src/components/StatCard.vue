<script setup lang="ts">
/**
 * 指标卡：主数值 + 单位 + 副标题 + 可选迷你趋势线。
 *
 * 用于总览的 KPI 行与渠道健康度；数值用等宽数字避免跳动。
 */
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string;
    hint?: string;
    icon?: string;
    tone?: 'default' | 'good' | 'warn' | 'bad' | 'info';
    /** 迷你趋势数据(0-1 之间的相对值数组) */
    trend?: number[];
  }>(),
  { tone: 'default' },
);

const trendPath = computed(() => {
  const data = props.trend ?? [];
  if (data.length < 2) return '';
  const max = Math.max(...data, 0.0001);
  return data
    .map((value, index) => {
      const x = (index / (data.length - 1)) * 100;
      const y = 24 - (value / max) * 22;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
});
</script>

<template>
  <div class="card" :class="`tone-${tone}`">
    <div class="top">
      <span class="label">{{ label }}</span>
      <AppIcon v-if="icon" :name="icon" :size="15" class="ico" />
    </div>
    <div class="value">{{ value }}</div>
    <div class="bottom">
      <span v-if="hint" class="hint">{{ hint }}</span>
      <svg v-if="trendPath" class="trend" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
        <path :d="trendPath" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.card {
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 96px;
  transition: border-color var(--dur) var(--ease);
}

.card:hover {
  border-color: var(--border);
}

.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.label {
  font-size: 12.5px;
  color: var(--text-3);
}

.ico {
  color: var(--text-3);
  opacity: 0.7;
}

.value {
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}

.bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  margin-top: auto;
}

.hint {
  font-size: 11.5px;
  color: var(--text-3);
}

.trend {
  width: 68px;
  height: 22px;
  flex: none;
  color: var(--accent);
  opacity: 0.85;
}

.tone-good .value {
  color: var(--accent);
}

.tone-warn .value {
  color: var(--warn);
}

.tone-bad .value {
  color: var(--danger);
}

.tone-info .value {
  color: var(--info);
}
</style>
