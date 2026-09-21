<script setup lang="ts">
/**
 * 流量时序图：最近 60 分钟请求量（成功/失败堆叠）+ 悬停十字线与明细。
 *
 * 设计取舍：
 *   - 柱状用 SVG（preserveAspectRatio=none 撑满宽度），坐标文字与 tooltip 用 HTML
 *     叠加，避免非等比缩放把文字拉变形；
 *   - 失败既用颜色也用高度表达（堆叠在成功柱上方），不单靠颜色传达信息；
 *   - 悬停十字线 + 明细卡是真实运维台的标准读数方式，比纯静态图更有用。
 */
import { computed, ref } from 'vue';
import AppIcon from './AppIcon.vue';
import { fmtHm } from '../format';
import type { MinuteBucket } from '../types';

const props = defineProps<{ series: MinuteBucket[] }>();

const H = 168;
/** 空态高度：不必为一个「暂无数据」占满整块图表区，留出空间给下方内容 */
const EMPTY_H = 104;
const hoverIndex = ref<number | null>(null);
const trackRef = ref<HTMLElement | null>(null);

const max = computed(() => Math.max(1, ...props.series.map((item) => item.total)));

interface Bar {
  x: number;
  successY: number;
  successH: number;
  errorY: number;
  errorH: number;
  width: number;
}

const bars = computed<Bar[]>(() => {
  const list = props.series;
  if (!list.length) return [];
  const width = 1000;
  const gap = 2.2;
  const barWidth = Math.max(1, (width - gap * (list.length - 1)) / list.length);
  return list.map((item, index) => {
    const x = index * (barWidth + gap);
    const success = item.total - item.errors;
    const successH = success > 0 ? Math.max(1.5, (success / max.value) * (H - 8)) : 0;
    const errorH = item.errors > 0 ? Math.max(1.5, (item.errors / max.value) * (H - 8)) : 0;
    const errorY = H - successH - errorH;
    return { x, successY: H - successH, successH, errorY, errorH, width: barWidth };
  });
});

/** 三条水平网格线（0 / 50% / 100% 峰值） */
const gridLines = computed(() => [0, 0.5, 1].map((ratio) => ({ y: H - ratio * (H - 8), value: Math.round(max.value * ratio) })));

const hovered = computed(() => (hoverIndex.value === null ? null : props.series[hoverIndex.value] ?? null));

const crosshairX = computed(() => {
  if (hoverIndex.value === null || !bars.value[hoverIndex.value]) return 0;
  return bars.value[hoverIndex.value].x + bars.value[hoverIndex.value].width / 2;
});

function onMove(event: PointerEvent): void {
  const track = trackRef.value;
  if (!track || props.series.length === 0) return;
  const rect = track.getBoundingClientRect();
  const ratio = (event.clientX - rect.left) / rect.width;
  hoverIndex.value = Math.min(props.series.length - 1, Math.max(0, Math.floor(ratio * props.series.length)));
}

function onLeave(): void {
  hoverIndex.value = null;
}

/** tooltip 在靠近右边界时左移，避免溢出容器 */
const tooltipStyle = computed(() => {
  if (hoverIndex.value === null) return {};
  const ratio = (hoverIndex.value + 0.5) / props.series.length;
  const percent = ratio * 100;
  return {
    left: `${percent}%`,
    transform: percent > 70 ? 'translate(-100%, -100%)' : 'translate(-8px, -100%)',
  };
});

const totalWindow = computed(() => props.series.reduce((sum, item) => sum + item.total, 0));
</script>

<template>
  <div class="wrap">
    <div v-if="totalWindow === 0" class="empty">
      <AppIcon name="activity" :size="18" />
      <div>
        <div class="empty-title">最近 60 分钟暂无请求</div>
        <div class="empty-hint">网关已就绪，客户端发起调用后这里会实时刷新</div>
      </div>
    </div>
    <template v-else>
      <div class="plot" ref="trackRef" @pointermove="onMove" @pointerleave="onLeave">
        <svg :viewBox="`0 0 1000 ${H}`" preserveAspectRatio="none" role="img" aria-label="最近 60 分钟请求量趋势">
          <line
            v-for="line in gridLines"
            :key="line.y"
            x1="0"
            :y1="line.y"
            x2="1000"
            :y2="line.y"
            class="grid"
          />
          <template v-for="(bar, index) in bars" :key="index">
            <rect
              v-if="bar.successH > 0"
              :x="bar.x"
              :y="bar.successY"
              :width="bar.width"
              :height="bar.successH"
              rx="1.4"
              class="bar-success"
            />
            <rect
              v-if="bar.errorH > 0"
              :x="bar.x"
              :y="bar.errorY"
              :width="bar.width"
              :height="bar.errorH"
              rx="1.4"
              class="bar-error"
            />
          </template>
          <line v-if="hoverIndex !== null" :x1="crosshairX" y1="0" :x2="crosshairX" :y2="H" class="crosshair" />
        </svg>

        <div v-if="hovered" class="tooltip" :style="tooltipStyle">
          <div class="tip-time">{{ fmtHm(hovered.minute) }}</div>
          <div class="tip-row"><span>请求</span><b>{{ hovered.total }}</b></div>
          <div class="tip-row"><span>失败</span><b :class="{ bad: hovered.errors > 0 }">{{ hovered.errors }}</b></div>
          <div class="tip-row">
            <span>平均耗时</span>
            <b>{{ hovered.total ? Math.round(hovered.durationSumMs / hovered.total) + ' ms' : '—' }}</b>
          </div>
        </div>
      </div>

      <div class="axis">
        <span>{{ fmtHm(series[0]?.minute) }}</span>
        <span>{{ fmtHm(series[Math.floor(series.length / 2)]?.minute) }}</span>
        <span>现在</span>
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
  height: v-bind('H + "px"');
  cursor: crosshair;
}

.plot svg {
  width: 100%;
  height: 100%;
  display: block;
}

.grid {
  stroke: var(--chart-grid);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.bar-success {
  fill: var(--chart-bar);
}

.bar-error {
  fill: var(--chart-error);
  opacity: 0.85;
}

.crosshair {
  stroke: var(--text-3);
  stroke-width: 1;
  stroke-dasharray: 3 3;
  vector-effect: non-scaling-stroke;
}

.tooltip {
  position: absolute;
  top: 0;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 12px;
  min-width: 132px;
  pointer-events: none;
  box-shadow: 0 12px 28px rgba(2, 6, 23, 0.5);
  z-index: 2;
}

.tip-time {
  color: var(--text-3);
  margin-bottom: 4px;
  font-variant-numeric: tabular-nums;
}

.tip-row {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  line-height: 1.7;
}

.tip-row span {
  color: var(--text-3);
}

.tip-row b {
  font-variant-numeric: tabular-nums;
}

.tip-row b.bad {
  color: var(--danger);
}

.axis {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.empty {
  height: v-bind('EMPTY_H + "px"');
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-3);
}

.empty-title {
  font-size: 13px;
  color: var(--text-2);
}

.empty-hint {
  font-size: 11.5px;
  color: var(--text-3);
  margin-top: 2px;
}
</style>
