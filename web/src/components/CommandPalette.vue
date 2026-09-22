<script setup lang="ts">
/**
 * 命令面板（Ctrl/Cmd + K）。
 *
 * 真实运维台的标准效率入口：键盘直达任意视图与常用动作，
 * 并支持按关键字过滤；↑↓ 选择、Enter 执行、Esc 关闭。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { NInput, NModal, useMessage } from 'naive-ui';
import AppIcon from './AppIcon.vue';
import { ROUTES, navigate } from '../router';
import { refreshNow } from '../autoRefresh';
import { writeClipboard } from '../clipboard';

const props = defineProps<{ show: boolean }>();
const emit = defineEmits<{ (event: 'update:show', value: boolean): void }>();

const message = useMessage();

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
const listRef = ref<HTMLElement | null>(null);

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
      // 用统一封装：明文 HTTP 下 navigator.clipboard 不存在，
      // 直接调用会静默失败（这里原先的 .catch 正是把失败吞掉了）
      if (!writeClipboard(`${window.location.origin}/v1`)) message.error('复制失败，请手动选中文本');
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

/**
 * 把当前高亮项滚进可视区。
 *
 * 之前缺这一步：列表 max-height 300px 而选项超过 6 个就会溢出，
 * 键盘一路 ↓ 到底时高亮项已滚出可视区、scrollTop 仍是 0——
 * 用户看不见自己在选什么。命令面板主打全键盘操作，这是硬伤。
 *
 * block:'nearest' 而非 'center'：相邻项移动时只做最小滚动，
 * 否则每按一次 ↓ 整个列表都跟着跳一下，反而更难跟。
 */
watch(active, () => {
  void nextTick(() => {
    listRef.value?.querySelector('.item.active')?.scrollIntoView({ block: 'nearest' });
  });
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
      <div ref="listRef" class="list">
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
  border-radius: 14px;
  overflow: hidden;
  /* 浅色下浮层靠阴影托起（原深色用的 rgba(2,6,23,.75) 在浅底上是一团脏影） */
  box-shadow: var(--shadow-pop);
}

.list {
  max-height: 300px;
  overflow: auto;
  padding: 6px;
  border-top: 1px solid var(--border-soft);
  /* 滚动条常隐：仅在内容溢出时占位，避免列表短时右侧留一条空槽 */
  scrollbar-width: thin;
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
  border-radius: 8px;
  font: inherit;
  font-size: 13px;
  text-align: left;
  /* 左侧轨道常驻，激活时以强调色填充：用位移以外的第二种方式指示当前项 */
  box-shadow: inset 2px 0 0 transparent;
  transition: background 140ms var(--ease), color 140ms var(--ease),
    box-shadow 140ms var(--ease);
}

.item.active {
  background: var(--accent-soft);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}

.item.active .hint {
  /* 激活项的分组标签同步提亮，否则高亮块里的灰字看起来像禁用 */
  color: var(--text-2);
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
