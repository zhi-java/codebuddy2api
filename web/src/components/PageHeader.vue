<script setup lang="ts">
/**
 * 视图页头：标题 + 一句说明 + 右侧操作。
 *
 * 极简口径：说明文字限制在一行可读长度内，不再堆叠多行副标题。
 */
defineProps<{ title: string; desc?: string }>();
</script>

<template>
  <div class="page-head">
    <div>
      <h1>{{ title }}</h1>
      <p v-if="desc">{{ desc }}</p>
    </div>
    <div v-if="$slots.default" class="actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  flex-wrap: wrap;
  margin-bottom: 32px;
}

h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 640;
  letter-spacing: -0.025em;
}

p {
  margin: 7px 0 0;
  font-size: 13px;
  color: var(--text-3);
  max-width: 560px;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  flex-wrap: wrap;
}

@media (max-width: 640px) {
  .page-head {
    margin-bottom: 24px;
  }

  h1 {
    font-size: 19px;
  }
}
</style>
