<script setup lang="ts">
/**
 * 表格骨架：加载期占位。
 *
 * 存在的意义不只是「好看」——首屏用骨架替代整张表，可避免 #empty 的
 * 「暂无数据」在已有数据时闪现一次（加载期间 data 为空会触发空态插槽）。
 *
 * 极简口径：用发丝线色块，不做渐变微光动画（那是入场动效，本设计不做）。
 */
import { NSkeleton } from 'naive-ui';

withDefaults(defineProps<{ widths?: number[]; rows?: number }>(), {
  widths: () => [1, 1, 1],
  rows: 5,
});
</script>

<template>
  <div class="skeleton">
    <div v-for="row in rows" :key="row" class="row">
      <NSkeleton
        v-for="(w, i) in widths"
        :key="i"
        text
        :sharp="false"
        height="12px"
        :width="`${Math.round((w / widths.reduce((a, b) => a + b, 0)) * 100)}%`"
      />
    </div>
  </div>
</template>

<style scoped>
.skeleton {
  display: flex;
  flex-direction: column;
}

.row {
  display: flex;
  align-items: center;
  gap: 24px;
  padding: 15px 0;
  border-bottom: 1px solid var(--line);
}

.row:last-child {
  border-bottom: none;
}
</style>
