<script setup lang="ts">
/**
 * 分段控件。
 *
 * 极简口径：用**下划线**表示选中，不用滑块背景块。
 * 上一版是「灰底容器 + 白色滑块 + 阴影」，三个装饰层只为表达一个状态。
 * 这里改成与顶栏导航同一套语言（文字 + 2px 下划线），全站选中态一致。
 */
withDefaults(
  defineProps<{
    modelValue: string;
    options: { value: string; label: string }[];
    /** 无障碍标签；视觉上不显示 */
    label?: string;
  }>(),
  { label: '' },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
</script>

<template>
  <div class="seg" role="group" :aria-label="label || undefined">
    <button
      v-for="item in options"
      :key="item.value"
      type="button"
      :class="{ on: modelValue === item.value }"
      :aria-pressed="modelValue === item.value"
      @click="emit('update:modelValue', item.value)"
    >
      {{ item.label }}
    </button>
  </div>
</template>

<style scoped>
/* 窄屏下选项可能放不下，允许横向滚动而非折行（折行会断开下划线选中态） */
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
</style>
