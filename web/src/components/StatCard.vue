<script setup lang="ts">
/**
 * 指标卡：标签 + 主数值 + 环比 + 迷你趋势。
 *
 * 三个层次按阅读优先级排布——数值最大，标签次之，环比与趋势只作佐证。
 * 趋势线在数据不足两点时不渲染：空卡片里画一条假线比不画更糟。
 */
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';

const props = withDefaults(
  defineProps<{
    label: string;
    value: string;
    /** 数值后缀，如 /min、% */
    unit?: string;
    hint?: string;
    icon?: string;
    tone?: 'default' | 'good' | 'warn' | 'bad' | 'info';
    /** 迷你趋势的原始值数组（内部按极值归一化，无需预处理） */
    trend?: number[];
    /** 环比文案，如「较昨日 +12.5%」 */
    deltaText?: string;
    deltaTone?: 'up' | 'down' | 'flat';
  }>(),
  { tone: 'default', deltaTone: 'flat' },
);

const SPARK_W = 100;
const SPARK_H = 28;

/** 迷你趋势：折线 + 面积填充，按自身极值归一化 */
const spark = computed(() => {
  const data = props.trend ?? [];
  if (data.length < 2) return null;

  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;

  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * SPARK_W;
    const y = SPARK_H - ((value - min) / span) * (SPARK_H - 6) - 3;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const line = `M${points.join(' L')}`;
  return { line, area: `${line} L${SPARK_W},${SPARK_H} L0,${SPARK_H} Z` };
});

const deltaIcon = computed(() => (props.deltaTone === 'up' ? 'arrow-up' : props.deltaTone === 'down' ? 'arrow-down' : ''));
</script>

<template>
  <div class="kpi" :class="`tone-${tone}`">
    <div class="top">
      <span class="label">{{ label }}</span>
      <AppIcon v-if="icon" :name="icon" :size="15" class="ico" />
    </div>

    <div class="value tnum">
      {{ value }}<small v-if="unit && value !== '—'">{{ unit }}</small>
    </div>

    <div v-if="hint || deltaText" class="meta">
      <span v-if="deltaText" class="delta" :class="deltaTone">
        <AppIcon v-if="deltaIcon" :name="deltaIcon" :size="12" />
        {{ deltaText }}
      </span>
      <span v-if="hint" class="hint">{{ hint }}</span>
    </div>

    <svg v-if="spark" class="spark" :viewBox="`0 0 ${SPARK_W} ${SPARK_H}`" preserveAspectRatio="none" aria-hidden="true">
      <path :d="spark.area" class="spark-area" />
      <path :d="spark.line" class="spark-line" />
    </svg>
  </div>
</template>

<style scoped>
.kpi {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px 0;
  min-height: 112px;
  background: var(--surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color var(--dur) var(--ease);
}

.kpi:hover {
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
  opacity: 0.65;
}

.value {
  font-size: 25px;
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.15;
}

.value small {
  font-size: 13px;
  font-weight: 550;
  color: var(--text-3);
  margin-left: 3px;
  letter-spacing: 0;
}

.meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11.5px;
  color: var(--text-3);
  min-height: 16px;
}

.delta {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.delta.up {
  color: var(--accent);
}

.delta.down {
  color: var(--danger);
}

.delta.flat {
  color: var(--text-3);
}

/* 趋势线贴住卡片底边，作为背景佐证而非主体 */
.spark {
  display: block;
  width: calc(100% + 32px);
  height: 34px;
  margin: auto -16px 0;
}

.spark-line {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
  vector-effect: non-scaling-stroke;
  opacity: 0.9;
}

.spark-area {
  fill: currentColor;
  opacity: 0.12;
  stroke: none;
}

.tone-good .value,
.tone-good .spark {
  color: var(--accent);
}

.tone-warn .value,
.tone-warn .spark {
  color: var(--warn);
}

.tone-bad .value,
.tone-bad .spark {
  color: var(--danger);
}

.tone-info .value,
.tone-info .spark {
  color: var(--info);
}

.tone-default .spark {
  color: var(--text-3);
}
</style>
