<script setup lang="ts">
/**
 * 命令面板（Ctrl/Cmd + K）。
 *
 * 真实运维台的标准效率入口：键盘直达任意视图与常用动作，
 * 并支持按关键字过滤；↑↓ 选择、Enter 执行、Esc 关闭。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { NInput, NModal } from 'naive-ui';
import AppIcon from './AppIcon.vue';
import { ROUTES, navigate } from '../router';
import { refreshNow } from '../autoRefresh';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (event: 'update:show', value: boolean): void }>();

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  run: () => void;
}

const query = ref('');
const active = ref(0);
const inputRef = ref<InstanceType<typeof NInput> | null>(null);

const commands = computed<Command[]>(() => [
  ...ROUTES.map((item) => ({
    id: `nav:${item.name}`,
    label: `前往 ${item.label}`,
    hint: item.group,
    icon: item.icon,
    run: () => navigate(item.name),
  })),
  {
    id: 'action:refresh',
    label: '刷新当前视图数据',
    hint: '动作',
    icon: 'refresh',
    run: () => refreshNow(),
  },
  {
    id: 'action:copy-base',
    label: '复制网关 Base URL',
    hint: '动作',
    icon: 'link',
    run: () => {
      void navigator.clipboard.writeText(`${window.location.origin}/v1`).catch(() => undefined);
    },
  },
  {
    id: 'action:docs',
    label: '打开 /v1/models 模型目录',
    hint: '动作',
    icon: 'external',
    run: () => window.open('/v1/models', '_blank', 'noopener'),
  },
]);

const filtered = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return commands.value;
  return commands.value.filter((item) => `${item.label} ${item.hint ?? ''}`.toLowerCase().includes(keyword));
});

watch(
  () => props.show,
  (visible) => {
    if (!visible) return;
    query.value = '';
    active.value = 0;
    void nextTick(() => inputRef.value?.focus());
  },
);

watch(filtered, () => {
  active.value = 0;
});

function close(): void {
  emit('update:show', false);
}

function runSelected(): void {
  const command = filtered.value[active.value];
  if (!command) return;
  command.run();
  close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    active.value = Math.min(filtered.value.length - 1, active.value + 1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    active.value = Math.max(0, active.value - 1);
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runSelected();
  }
}
</script>

<template>
  <NModal
    :show="show"
    :mask-closable="true"
    transform-origin="center"
    @update:show="(value: boolean) => emit('update:show', value)"
  >
    <div class="palette" role="dialog" aria-label="命令面板">
      <NInput
        ref="inputRef"
        v-model:value="query"
        placeholder="输入命令或视图名…"
        :bordered="false"
        size="large"
        @keydown="onKeydown"
      />
      <div class="list">
        <button
          v-for="(command, index) in filtered"
          :key="command.id"
          class="item"
          :class="{ active: index === active }"
          @mouseenter="active = index"
          @click="() => { active = index; runSelected(); }"
        >
          <AppIcon :name="command.icon" :size="15" />
          <span class="label">{{ command.label }}</span>
          <span v-if="command.hint" class="hint">{{ command.hint }}</span>
        </button>
        <div v-if="filtered.length === 0" class="empty">没有匹配的命令</div>
      </div>
      <div class="foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 执行</span>
        <span><kbd>Esc</kbd> 关闭</span>
      </div>
    </div>
  </NModal>
</template>

<style scoped>
.palette {
  width: min(560px, calc(100vw - 32px));
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(2, 6, 23, 0.55);
}

.list {
  max-height: 300px;
  overflow: auto;
  padding: 6px;
  border-top: 1px solid var(--border-soft);
}

.item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: none;
  background: none;
  color: var(--text-2);
  border-radius: 7px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  transition: background 140ms var(--ease), color 140ms var(--ease);
}

.item.active {
  background: var(--accent-soft);
  color: var(--text);
}

.label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.hint {
  font-size: 11.5px;
  color: var(--text-3);
}

.empty {
  padding: 20px;
  text-align: center;
  color: var(--text-3);
  font-size: 12.5px;
}

.foot {
  display: flex;
  gap: 16px;
  padding: 8px 12px;
  border-top: 1px solid var(--border-soft);
  font-size: 11.5px;
  color: var(--text-3);
}

kbd {
  background: var(--surface-3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 5px;
  margin-right: 4px;
  font-size: 10.5px;
}
</style>
