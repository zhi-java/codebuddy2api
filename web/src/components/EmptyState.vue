<script setup lang="ts">
/**
 * 空态：图标 + 标题 + 说明 + 可选操作按钮。
 * 三个层次都是真实项目里必要的：解释「为什么空」并给出下一步。
 */
import AppIcon from './AppIcon.vue';

withDefaults(defineProps<{ icon?: string; title: string; desc?: string }>(), { icon: 'inbox' });
</script>

<template>
  <div class="empty">
    <div class="ico"><AppIcon :name="icon" :size="22" /></div>
    <div class="title">{{ title }}</div>
    <p v-if="desc">{{ desc }}</p>
    <div class="action"><slot /></div>
  </div>
</template>

<style scoped>
.empty {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-3);
}

.ico {
  display: inline-grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--surface-3);
  color: var(--text-2);
  margin-bottom: 12px;
}

.title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

p {
  margin: 6px auto 0;
  max-width: 46ch;
  font-size: 12.5px;
  line-height: 1.7;
}

.action:not(:empty) {
  margin-top: 14px;
}
</style>
