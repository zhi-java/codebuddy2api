<script setup lang="ts">
/**
 * 趋势柱图：按日 / 按月的请求量、Token 或积分。
 *
 * 用 HTML/CSS 柱而非 SVG 的原因：日序列有 30 根柱，SVG 靠 viewBox 撑满宽度会把
 * 圆角与描边非等比拉伸；HTML 柱天然像素对齐，还能白拿 transition 动画。
 *
 * 可访问性：每根柱是一个可聚焦按钮，读屏能逐日读出数值——图表信息不再只依赖
 * 悬停，键盘用户与读屏用户都能拿到同一份数据。
 */
import { computed, ref } from 'vue';
import { fmtCredit, fmtTokens, num } from '../format';
import type { TrendMetric, TrendPoint } from '../types';

const props = defineProps<{
  items: TrendPoint[];
  metric: TrendMetric;
  /** 空态文案 */
  emptyHint?: string;
}>();

/** 柱区高度（px），与 CSS 中的 .bars 高度保持一致 */
const PLOT_H = 176;
const GRID_RATIOS = [1, 0.5, 0];

const hoverIndex = ref<number | null>(null);

/** 非零值的最小可见高度：0.4% 的失败率不该在图上完全看不见 */
const MIN_SEGMENT_PX = 2;

function valueOf(point: TrendPoint): number {
  if (props.metric === 'tokens') return point.tokens;
  if (props.metric === 'credit') return point.credit;
  return point.total;
}

const peak = computed(() => Math.max(1, ...props.items.map(valueOf)));

const isEmpty = computed(() => props.items.every((item) => valueOf(item) === 0));

const gridLines = computed(() =>
  GRID_RATIOS.map((ratio) => ({
    ratio,
    bottom: `${ratio * 100}%`,
    label: formatValue(peak.value * ratio),
  })),
);

interface Segment {
  successPx: number;
  errorPx: number;
}

/**
 * 柱高换算成像素。
 *
 * 用像素而非百分比：最小可见高度的补偿会让「成功段 + 失败段」超过 100%，
 * 柱顶被顶出画布、两段之间出现缝隙。这里先按峰值折算，再整体夹紧到画布内，
 * 保证任何输入下柱子都落在框内且两段严丝合缝。
 */
const segments = computed<Segment[]>(() => {
  const scale = PLOT_H / peak.value;
  return props.items.map((point) => {
    if (props.metric !== 'requests') {
      const value = valueOf(point);
      return { successPx: value > 0 ? Math.min(PLOT_H, Math.max(MIN_SEGMENT_PX, value * scale)) : 0, errorPx: 0 };
    }

    const successUnits = Math.max(0, point.total - point.error);
    let successPx = successUnits > 0 ? Math.max(MIN_SEGMENT_PX, successUnits * scale) : 0;
    let errorPx = point.error > 0 ? Math.max(MIN_SEGMENT_PX, point.error * scale) : 0;

    const sum = successPx + errorPx;
    if (sum > PLOT_H) {
      const factor = PLOT_H / sum;
      successPx *= factor;
      errorPx *= factor;
    }
    return { successPx, errorPx };
  });
});

const hovered = computed(() => (hoverIndex.value === null ? null : (props.items[hoverIndex.value] ?? null)));

const tooltipStyle = computed(() => {
  if (hoverIndex.value === null || props.items.length === 0) return {};
  const ratio = (hoverIndex.value + 0.5) / props.items.length;
  const percent = ratio * 100;
  return {
    left: `${percent}%`,
    transform: percent > 68 ? 'translate(-100%, -8px)' : 'translate(-8px, -8px)',
  };
});

/** 轴标签只取首/中/尾，30 天全铺会糊成一片 */
const axisTicks = computed(() => {
  const list = props.items;
  if (list.length === 0) return [];
  if (list.length <= 2) return list.map((item) => item.label);
  return [list[0].label, list[Math.floor(list.length / 2)].label, list[list.length - 1].label];
});

function formatValue(value: number): string {
  if (props.metric === 'tokens') return fmtTokens(value);
  if (props.metric === 'credit') return fmtCredit(value);
  return num(Math.round(value));
}

/** 柱的无障碍标签：把该日/月的完整读数摊开 */
function barLabel(point: TrendPoint): string {
  if (props.metric !== 'requests') return `${point.title} ${formatValue(valueOf(point))}`;
  return `${point.title} 请求 ${point.total} 次，失败 ${point.error} 次`;
}

/** 悬停提示里按当前度量展示主数值 */
const hoveredRows = computed(() => {
  const point = hovered.value;
  if (!point) return [];
  if (props.metric === 'tokens') {
    return [
      { label: 'Token 合计', value: fmtTokens(point.tokens) },
      { label: '请求', value: `${num(point.total)} 次` },
    ];
  }
  if (props.metric === 'credit') {
    return [
      { label: '积分消耗', value: fmtCredit(point.credit) },
      { label: '请求', value: `${num(point.total)} 次` },
    ];
  }
  return [
    { label: '请求', value: `${num(point.total)} 次` },
    { label: '失败', value: `${num(point.error)} 次` },
    { label: '成功率', value: point.total ? `${Math.round(((point.total - point.error) / point.total) * 1000) / 10}%` : '—' },
  ];
});
</script>

<template>
  <div class="wrap">
    <div v-if="items.length === 0 || isEmpty" class="empty" :style="{ height: PLOT_H + 28 + 'px' }">
      {{ emptyHint ?? '该区间暂无数据' }}
    </div>

    <template v-else>
      <div class="plot" :style="{ height: PLOT_H + 'px' }">
        <div class="grid-lines" aria-hidden="true">
          <div v-for="line in gridLines" :key="line.ratio" class="grid-line" :style="{ bottom: line.bottom }">
            <span class="grid-label tnum">{{ line.label }}</span>
          </div>
        </div>

        <div class="bars" role="list" @pointerleave="hoverIndex = null">
          <button
            v-for="(item, index) in items"
            :key="item.key"
            type="button"
            role="listitem"
            class="col"
            :class="{ dim: hoverIndex !== null && hoverIndex !== index }"
            :aria-label="barLabel(item)"
            @pointerenter="hoverIndex = index"
            @focus="hoverIndex = index"
            @blur="hoverIndex = null"
          >
            <span class="col-stack">
              <span
                v-if="segments[index].errorPx > 0"
                class="seg error"
                :style="{ height: segments[index].errorPx + 'px' }"
              />
              <span
                class="seg"
                :class="metric === 'requests' ? 'success' : 'plain'"
                :style="{ height: segments[index].successPx + 'px' }"
              />
            </span>
          </button>
        </div>

        <div v-if="hovered" class="tooltip" :style="tooltipStyle">
          <div class="tip-title">{{ hovered.title }}</div>
          <div v-for="row in hoveredRows" :key="row.label" class="tip-row">
            <span>{{ row.label }}</span>
            <b class="tnum">{{ row.value }}</b>
          </div>
        </div>
      </div>

      <div class="axis">
        <span v-for="(tick, index) in axisTicks" :key="index">{{ tick }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.wrap {
  width: 100%;
}

.plot {
  position: relative;
  padding-right: 44px;
}

.grid-lines {
  position: absolute;
  inset: 0 44px 0 0;
  pointer-events: none;
}

.grid-line {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--chart-grid);
}

.grid-label {
  position: absolute;
  right: -44px;
  top: -8px;
  width: 40px;
  text-align: right;
  font-size: 10.5px;
  color: var(--text-3);
}

.bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 100%;
}

.col {
  flex: 1;
  min-width: 0;
  height: 100%;
  padding: 0;
  border: none;
  background: none;
  display: flex;
  align-items: flex-end;
  transition: opacity var(--dur) var(--ease);
}

.col.dim {
  opacity: 0.45;
}

.col-stack {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  width: 100%;
  height: 100%;
}

.seg {
  width: 100%;
  border-radius: 2px 2px 0 0;
  transition: height 320ms var(--ease);
}

.seg.success {
  background: var(--chart-bar-strong);
}

/* 失败段叠在成功段之上：既用颜色也用高度表达，不单靠颜色传达信息 */
.seg.error {
  background: var(--chart-error);
  border-radius: 0;
}

.seg.plain {
  background: linear-gradient(180deg, var(--chart-token), rgba(56, 189, 248, 0.3));
}

.tooltip {
  position: absolute;
  top: 0;
  z-index: 2;
  min-width: 148px;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  font-size: 12px;
  pointer-events: none;
}

.tip-title {
  color: var(--text-3);
  margin-bottom: 4px;
}

.tip-row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  line-height: 1.75;
}

.tip-row span {
  color: var(--text-3);
}

.tip-row b {
  font-weight: 600;
}

.axis {
  display: flex;
  justify-content: space-between;
  margin: 6px 44px 0 0;
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.empty {
  display: grid;
  place-items: center;
  color: var(--text-3);
  font-size: 12.5px;
}
</style>
