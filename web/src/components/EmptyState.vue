<script setup lang="ts">
/**
 * 空态：一个淡图标 + 标题 + 说明 + 可选操作。
 *
 * 极简口径：图标用发丝线色（不抢视线），文案保持两行以内。
 */
import AppIcon from './AppIcon.vue';

defineProps<{ icon: string; title: string; desc?: string }>();
</script>

<template>
  <div class="empty">
    <AppIcon :name="icon" :size="26" />
    <b>{{ title }}</b>
    <span v-if="desc">{{ desc }}</span>
    <div v-if="$slots.default" class="act"><slot /></div>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 64px 20px;
  text-align: center;
  color: var(--text-3);
}

.empty :deep(svg) {
  color: var(--line-strong);
}

b {
  color: var(--text-2);
  font-size: 13.5px;
  font-weight: 600;
}

span {
  font-size: 12.5px;
  max-width: 380px;
  line-height: 1.7;
}

.act {
  margin-top: 6px;
}
</style>
