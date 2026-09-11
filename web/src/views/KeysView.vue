<script setup lang="ts">
/**
 * API Keys：客户端密钥管理。
 *
 * 真实项目的三个关键点：
 *   1. 创建后明文只出现一次 → 提供复制与 .env 片段下载；
 *   2. Key 与上游凭证是多对多 → 绑定以勾选列表呈现并显示凭证健康度；
 *   3. 模型别名是 Key 级配置 → 表格化编辑（增删行 + 校验），不再让用户手写文本。
 */
import { computed, h, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NCard,
  NCheckbox,
  NDataTable,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NSelect,
  NSpace,
  NTag,
  NTooltip,
  useDialog,
  useMessage,
  type DataTableColumns,
} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import { api, type DataResponse } from '../api';
import { tick } from '../autoRefresh';
import { STATUS_META, fmtTime, relTime } from '../format';
import { refreshKeys, store } from '../store';
import type { KeySummary } from '../types';

const message = useMessage();
const dialog = useDialog();

const keyword = ref('');
const busyId = ref('');

const showCreate = ref(false);
const creating = ref(false);
const newKey = ref({ name: '', credentialIds: [] as string[] });

const secret = ref<{ name: string; plaintext: string } | null>(null);

const showAlias = ref(false);
const aliasTarget = ref<KeySummary | null>(null);
const aliasRows = ref<{ client: string; upstream: string }[]>([]);

const showBind = ref(false);
const bindTarget = ref<KeySummary | null>(null);
const bindSelection = ref<string[]>([]);

const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  if (!query) return store.keys;
  return store.keys.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query));
});

function boundNames(key: KeySummary): string {
  if (!key.credentialIds.length) return '未绑定';
  return key.credentialIds
    .map((id) => store.credentials.find((cred) => cred.id === id)?.name ?? id)
    .join('、');
}

/** 绑定的凭证里有几个不健康：一眼看出这个 Key 的可用性风险 */
function boundWarnings(key: KeySummary): number {
  return key.credentialIds.filter((id) => store.credentials.find((cred) => cred.id === id)?.status !== 'healthy').length;
}

const upstreamOptions = computed(() =>
  store.credentials.map((cred) => ({
    label: `${cred.name}（${STATUS_META[cred.status]?.label ?? cred.status}）`,
    value: cred.name,
  })),
);

const columns = computed<DataTableColumns<KeySummary>>(() => [
  {
    title: '名称 / ID',
    key: 'name',
    minWidth: 190,
    render: (row) =>
      h('div', null, [
        h('div', { style: 'font-weight:550' }, row.name),
        h('div', { class: 'mono sub' }, row.id),
      ]),
  },
  {
    title: '绑定上游凭证',
    key: 'credentialIds',
    minWidth: 220,
    render: (row) => {
      const warnings = boundWarnings(row);
      return h('div', null, [
        h('div', null, boundNames(row)),
        warnings > 0
          ? h('div', { class: 'sub bad' }, `${warnings} 个凭证非健康状态`)
          : h('div', { class: 'sub' }, `${row.credentialIds.length} 个凭证`),
      ]);
    },
  },
  {
    title: '模型别名',
    key: 'modelAliases',
    width: 110,
    render: (row) => {
      const count = Object.keys(row.modelAliases ?? {}).length;
      return h(NTag, { size: 'small', bordered: false, type: count ? 'info' : 'default' }, {
        default: () => (count ? `${count} 条` : '无'),
      });
    },
  },
  {
    title: '状态',
    key: 'enabled',
    width: 92,
    render: (row) =>
      h(NTag, { size: 'small', bordered: false, type: row.enabled ? 'success' : 'default' }, {
        default: () => (row.enabled ? '已启用' : '已停用'),
      }),
  },
  {
    title: '最近使用',
    key: 'lastUsedAt',
    width: 158,
    render: (row) =>
      h('div', null, [
        h('div', null, fmtTime(row.lastUsedAt)),
        h('div', { class: 'sub' }, row.lastUsedAt ? relTime(row.lastUsedAt) : '尚未使用'),
      ]),
  },
  {
    title: '操作',
    key: 'actions',
    width: 220,
    align: 'right',
    render: (row) =>
      h(NSpace, { justify: 'end', size: 4, wrap: false }, {
        default: () => [
          h(NButton, { size: 'tiny', quaternary: true, onClick: () => openBind(row) }, { default: () => '绑定' }),
          h(NButton, { size: 'tiny', quaternary: true, onClick: () => openAlias(row) }, { default: () => '别名' }),
          h(
            NButton,
            { size: 'tiny', quaternary: true, loading: busyId.value === row.id, onClick: () => doToggle(row) },
            { default: () => (row.enabled ? '停用' : '启用') },
          ),
          h(NButton, { size: 'tiny', quaternary: true, type: 'error', onClick: () => doDelete(row) }, { default: () => '删除' }),
        ],
      }),
  },
]);

async function run(id: string, label: string, fn: () => Promise<void>): Promise<void> {
  busyId.value = id;
  try {
    await fn();
  } catch (err) {
    message.error(`${label}失败：${(err as Error).message}`);
  } finally {
    busyId.value = '';
  }
}

async function doToggle(row: KeySummary): Promise<void> {
  await run(row.id, '状态切换', async () => {
    await api(`/admin/api/keys/${encodeURIComponent(row.id)}`, { method: 'PUT', body: { enabled: !row.enabled } });
    await refreshKeys();
  });
}

function doDelete(row: KeySummary): void {
  dialog.warning({
    title: '删除 Key',
    content: `确认删除 Key「${row.name}」？使用它的客户端将立即失效。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () =>
      run(row.id, '删除', async () => {
        await api(`/admin/api/keys/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
        message.success('已删除');
        await refreshKeys();
      }),
  });
}

function openBind(row: KeySummary): void {
  bindTarget.value = row;
  bindSelection.value = [...row.credentialIds];
  showBind.value = true;
}

async function submitBind(): Promise<void> {
  const target = bindTarget.value;
  if (!target) return;
  try {
    await api(`/admin/api/keys/${encodeURIComponent(target.id)}/bind`, {
      method: 'POST',
      body: { credentialIds: bindSelection.value },
    });
    message.success('绑定已更新');
    showBind.value = false;
    await refreshKeys();
  } catch (err) {
    message.error((err as Error).message);
  }
}

function toggleIn(list: string[], id: string, checked: boolean): string[] {
  return checked ? [...list, id] : list.filter((item) => item !== id);
}

function openAlias(row: KeySummary): void {
  aliasTarget.value = row;
  const aliases = row.modelAliases ?? {};
  aliasRows.value = Object.keys(aliases).map((client) => ({ client, upstream: aliases[client] }));
  if (aliasRows.value.length === 0) aliasRows.value = [{ client: '', upstream: '' }];
  showAlias.value = true;
}

function addAliasRow(): void {
  aliasRows.value = [...aliasRows.value, { client: '', upstream: '' }];
}

function removeAliasRow(index: number): void {
  aliasRows.value = aliasRows.value.filter((_, itemIndex) => itemIndex !== index);
}

async function submitAlias(): Promise<void> {
  const target = aliasTarget.value;
  if (!target) return;
  const modelAliases: Record<string, string> = {};
  for (const row of aliasRows.value) {
    const client = row.client.trim();
    const upstream = row.upstream.trim();
    if (!client || !upstream) continue;
    modelAliases[client] = upstream;
  }
  try {
    await api(`/admin/api/keys/${encodeURIComponent(target.id)}`, { method: 'PUT', body: { modelAliases } });
    message.success('模型别名已保存');
    showAlias.value = false;
    await refreshKeys();
  } catch (err) {
    message.error((err as Error).message);
  }
}

async function submitCreate(): Promise<void> {
  const name = newKey.value.name.trim();
  if (!name) {
    message.error('请填写名称');
    return;
  }
  creating.value = true;
  try {
    const res = await api<DataResponse<{ id: string; plaintext: string }>>('/admin/api/keys', {
      method: 'POST',
      body: { name, credentialIds: newKey.value.credentialIds },
    });
    showCreate.value = false;
    newKey.value = { name: '', credentialIds: [] };
    await refreshKeys();
    if (res.data?.plaintext) secret.value = { name, plaintext: res.data.plaintext };
  } catch (err) {
    message.error(`创建失败：${(err as Error).message}`);
  } finally {
    creating.value = false;
  }
}

async function copy(text: string, label = '已复制'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    message.success(label);
  } catch {
    message.error('复制失败，请手动选择');
  }
}

/** 生成可直接粘贴到客户端的 .env 片段（真实接入时最常用） */
const envSnippet = computed(() => {
  if (!secret.value) return '';
  const base = `${window.location.origin}/v1`;
  return [
    `# CodeBuddy Gateway`,
    `OPENAI_BASE_URL=${base}`,
    `OPENAI_API_KEY=${secret.value.plaintext}`,
    '',
    `# Anthropic 兼容客户端`,
    `ANTHROPIC_BASE_URL=${window.location.origin}`,
    `ANTHROPIC_AUTH_TOKEN=${secret.value.plaintext}`,
  ].join('\n');
});

function downloadEnv(): void {
  if (!secret.value) return;
  const blob = new Blob([envSnippet.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${secret.value.name || 'codebuddy'}.env`;
  anchor.click();
  URL.revokeObjectURL(url);
}

watch(tick, () => void refreshKeys());

onMounted(() => {
  void refreshKeys();
});
</script>

<template>
  <div class="page">
    <PageHeader title="API Keys" desc="客户端持网关 Key 调用；上游凭证由网关统一调度与刷新">
      <NButton secondary :loading="store.loading" @click="refreshKeys">
        <template #icon><AppIcon name="refresh" :size="15" /></template>
        刷新
      </NButton>
      <NButton type="primary" @click="showCreate = true">
        <template #icon><AppIcon name="plus" :size="15" /></template>
        创建 Key
      </NButton>
    </PageHeader>

    <div class="toolbar">
      <NInput v-model:value="keyword" placeholder="搜索 Key 名称或 ID" clearable style="max-width: 320px">
        <template #prefix><AppIcon name="search" :size="14" /></template>
      </NInput>
      <span class="sub">共 {{ filtered.length }} 个 Key</span>
    </div>

    <NCard size="small">
      <NDataTable
        :columns="columns"
        :data="filtered"
        :bordered="false"
        :single-line="false"
        size="small"
        :loading="store.loading"
        :scroll-x="1020"
        :pagination="{ pageSize: 10 }"
      >
        <template #empty>
          <EmptyState
            icon="keys"
            title="还没有客户端 Key"
            desc="创建 Key 并绑定上游凭证后，客户端即可用它调用网关（明文仅显示一次）。"
          >
            <NButton type="primary" size="small" @click="showCreate = true">创建 Key</NButton>
          </EmptyState>
        </template>
      </NDataTable>
    </NCard>

    <!-- 创建 Key -->
    <NModal
      v-model:show="showCreate"
      preset="card"
      title="创建 API Key"
      style="width: min(520px, calc(100vw - 32px))"
      :mask-closable="!creating"
    >
      <NForm label-placement="top">
        <NFormItem label="Key 名称">
          <NInput v-model:value="newKey.name" placeholder="例如：Claude Code / Codex CLI" />
        </NFormItem>
        <NFormItem label="绑定上游凭证（可多选，网关按健康度调度）">
          <div class="cred-list">
            <NCheckbox
              v-for="cred in store.credentials"
              :key="cred.id"
              :checked="newKey.credentialIds.includes(cred.id)"
              @update:checked="(checked: boolean) => (newKey.credentialIds = toggleIn(newKey.credentialIds, cred.id, checked))"
            >
              {{ cred.name }}
              <span class="sub">（{{ STATUS_META[cred.status]?.label ?? cred.status }}）</span>
            </NCheckbox>
            <span v-if="store.credentials.length === 0" class="sub">
              尚无上游凭证，请先前往「上游凭证」添加
            </span>
          </div>
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton :disabled="creating" @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="submitCreate">创建</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 明文（仅一次）+ 接入片段 -->
    <NModal
      :show="!!secret"
      preset="card"
      title="Key 创建成功"
      style="width: min(640px, calc(100vw - 32px))"
      @update:show="(value: boolean) => !value && (secret = null)"
    >
      <div class="warn">请立即保存。出于安全，明文仅显示这一次。</div>
      <div class="secret">
        <code class="mono">{{ secret?.plaintext }}</code>
        <NButton size="small" secondary @click="copy(secret?.plaintext ?? '')">
          <template #icon><AppIcon name="copy" :size="14" /></template>
          复制
        </NButton>
      </div>

      <div class="sec-title">客户端接入片段</div>
      <pre class="snippet mono">{{ envSnippet }}</pre>
      <template #footer>
        <NSpace justify="end">
          <NButton secondary @click="copy(envSnippet, '已复制接入片段')">
            <template #icon><AppIcon name="copy" :size="14" /></template>
            复制片段
          </NButton>
          <NButton secondary @click="downloadEnv">
            <template #icon><AppIcon name="download" :size="14" /></template>
            下载 .env
          </NButton>
          <NButton type="primary" @click="secret = null">我已保存</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 模型别名：表格化编辑 -->
    <NModal
      v-model:show="showAlias"
      preset="card"
      :title="`模型别名 · ${aliasTarget?.name ?? ''}`"
      style="width: min(620px, calc(100vw - 32px))"
    >
      <div class="sub" style="margin-bottom: 12px">
        客户端请求的 model 会被映射到右侧真实上游模型（匹配忽略 [1m] 等后缀）。
      </div>
      <div class="alias-head">
        <span>客户端模型名</span>
        <span />
        <span>上游模型名</span>
        <span />
      </div>
      <div class="alias-rows">
        <div v-for="(row, index) in aliasRows" :key="index" class="alias-row">
          <NSelect
            v-model:value="row.client"
            :options="upstreamOptions"
            filterable
            tag
            placeholder="客户端模型"
            size="small"
          />
          <AppIcon name="chevron" :size="14" class="arrow" />
          <NSelect
            v-model:value="row.upstream"
            :options="upstreamOptions"
            filterable
            tag
            placeholder="上游模型"
            size="small"
          />
          <NButton quaternary size="tiny" @click="removeAliasRow(index)">
            <template #icon><AppIcon name="x" :size="14" /></template>
          </NButton>
        </div>
      </div>
      <NButton dashed size="small" style="margin-top: 10px" @click="addAliasRow">
        <template #icon><AppIcon name="plus" :size="14" /></template>
        添加映射
      </NButton>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showAlias = false">取消</NButton>
          <NButton type="primary" @click="submitAlias">保存</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 绑定凭证 -->
    <NModal
      v-model:show="showBind"
      preset="card"
      :title="`绑定凭证 · ${bindTarget?.name ?? ''}`"
      style="width: min(520px, calc(100vw - 32px))"
    >
      <div class="cred-list">
        <NCheckbox
          v-for="cred in store.credentials"
          :key="cred.id"
          :checked="bindSelection.includes(cred.id)"
          @update:checked="(checked: boolean) => (bindSelection = toggleIn(bindSelection, cred.id, checked))"
        >
          {{ cred.name }}
          <span class="sub">（{{ STATUS_META[cred.status]?.label ?? cred.status }}）</span>
        </NCheckbox>
        <span v-if="store.credentials.length === 0" class="sub">无可用凭证</span>
      </div>
      <div class="sub" style="margin-top: 10px">网关按顺序调度绑定集中的健康凭证，失败自动切换到下一个。</div>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showBind = false">取消</NButton>
          <NButton type="primary" @click="submitBind">保存绑定</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.cred-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow: auto;
}

.warn {
  color: var(--warn);
  font-size: 12.5px;
  margin-bottom: 10px;
}

.secret {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 10px 12px;
}

.secret code {
  flex: 1;
  word-break: break-all;
  font-size: 12.5px;
}

.sec-title {
  margin: 18px 0 8px;
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-3);
}

.snippet {
  background: var(--surface-3);
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  padding: 12px;
  font-size: 12px;
  line-height: 1.7;
  margin: 0;
  overflow: auto;
  max-height: 200px;
}

.alias-head,
.alias-row {
  display: grid;
  grid-template-columns: 1fr 24px 1fr 30px;
  align-items: center;
  gap: 6px;
}

.alias-head {
  font-size: 11.5px;
  color: var(--text-3);
  margin-bottom: 6px;
}

.alias-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 260px;
  overflow: auto;
}

.arrow {
  color: var(--text-3);
  justify-self: center;
}

.bad {
  color: var(--danger);
}

:deep(.mono) {
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
}
</style>
