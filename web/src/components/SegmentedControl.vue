<script setup lang="ts">
/**
 * 分段控件：一组互斥选项的紧凑切换（时间范围、度量维度）。
 *
 * 用 radiogroup 语义而非普通按钮组：读屏会播报「第 2 项，共 4 项」，
 * 方向键也能切换——这是原生 select 之外唯一被广泛支持的单选模式。
 */
defineProps<{
  options: Array<{ value: string; label: string; hint?: string }>;
  modelValue: string;
  /** 无障碍分组名 */
  label?: string;
}>();

const emit = defineEmits<{ (event: 'update:modelValue', value: string): void }>();

function onKeydown(event: KeyboardEvent, index: number, total: number, options: Array<{ value: string }>): void {
  const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
    : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
      : 0;
  if (step === 0) return;
  event.preventDefault();
  const next = (index + step + total) % total;
  emit('update:modelValue', options[next].value);
}
</script>

<template>
  <div class="seg" role="radiogroup" :aria-label="label">
    <button
      v-for="(option, index) in options"
      :key="option.value"
      type="button"
      role="radio"
      class="item"
      :class="{ active: option.value === modelValue }"
      :aria-checked="option.value === modelValue"
      :title="option.hint"
      :tabindex="option.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', option.value)"
      @keydown="onKeydown($event, index, options.length, options)"
    >
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}

.item {
  padding: 4px 11px;
  border: none;
  border-radius: 6px;
  background: none;
  color: var(--text-3);
  font: inherit;
  font-size: 12.5px;
  font-weight: 550;
  white-space: nowrap;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}

.item:hover {
  color: var(--text-2);
}

.item.active {
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 2px rgba(2, 6, 23, 0.25);
}
</style>
