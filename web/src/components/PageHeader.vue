<script setup lang="ts">
/**
 * 页头：标题 + 说明 + 右侧操作区。
 * 所有视图统一用它，保证标题排版与操作按钮位置一致。
 */
defineProps<{ title: string; desc?: string }>();
</script>

<template>
  <header class="head">
    <div class="meta">
      <h1>{{ title }}</h1>
      <p v-if="desc">{{ desc }}</p>
    </div>
    <div class="actions">
      <slot />
    </div>
  </header>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.meta {
  min-width: 0;
}

h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.02em;
}

p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--text-3);
  max-width: 68ch;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
