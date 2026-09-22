<script setup lang="ts">
/**
 * 表格首屏骨架。
 *
 * 解决两个问题：
 *   1. 首屏加载时表格区只有 spinner，主体是空框（UX 规则：加载 > 300ms 需骨架屏）；
 *   2. **更重要的正确性问题**：加载期间 data 为空，NDataTable 会渲染 #empty 插槽，
 *      导致「还没有上游凭证」这类空态文案在已有数据的用户面前闪现一次，属于误导。
 *      加载中改用骨架替代整张表，空态只在真正加载完成后出现。
 *
 * 用骨架而非全屏 spinner：骨架保留了表格的行列结构，加载完成时布局不跳动（CLS）。
 * 列宽按各视图真实列配置传入，让骨架与最终内容对齐——若骨架列宽与真表格不一致，
 * 加载完成瞬间会有一次横向错位，比不做骨架更刺眼。
 */
import { computed } from 'vue';
import { NSkeleton } from 'naive-ui';

const props = withDefaults(
  defineProps<{
    /** 列宽比例（flex 值）；省略则等分 */
    widths?: number[];
    /** 骨架行数，应与表格首屏可见行数接近 */
    rows?: number;
  }>(),
  { rows: 6 },
);

const cols = computed(() => (props.widths?.length ? props.widths : [1, 1, 1, 1]));

defineOptions({ inheritAttrs: false });
</script>

<template>
  <div class="table-skeleton" role="status" aria-busy="true" aria-label="数据加载中">
    <div v-for="row in rows" :key="row" class="row">
      <NSkeleton
        v-for="(weight, col) in cols"
        :key="col"
        text
        :sharp="false"
        height="14px"
        :style="{ flex: weight, maxWidth: '100%' }"
      />
    </div>
  </div>
</template>

<style scoped>
.table-skeleton {
  padding: 6px 0 2px;
}

.row {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 11px 12px;
  /* 与 DataTable 的行分隔线同节奏，避免骨架看起来是另一张表 */
  border-bottom: 1px solid var(--border-soft);
}

.row:last-child {
  border-bottom: none;
}
</style>
