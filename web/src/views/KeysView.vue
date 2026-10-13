<script setup lang="ts">
/**
 * API Keys：客户端密钥管理（卡片式）。
 *
 * 为什么用卡片而非表格：每个 Key 携带三类**异构**信息——绑定关系（凭证/模型）、
 * 用量统计（日/月 × 请求/Token/积分）、配额进度。表格只能把它们压成扁平单元格，
 * 长列表下难以扫读；卡片允许每组信息以合适的形态呈现（标签、进度条、数值对）。
 *
 * 四项能力：
 *   1. 模型绑定：留空 = 全部可用（默认），选定后按白名单放行；
 *   2. 配额策略：请求数 / Token / 积分的日、月总量上限，卡片上以进度条呈现；
 *   3. 用量统计：服务端随列表一并返回当前窗口用量，无需额外请求；
 *   4. 可编辑：名称、启用状态、凭证绑定、模型绑定、配额均可修改。
 */
import { computed, onMounted, ref, watch } from 'vue';
import {
  NDropdown,
  NButton,
  NCheckbox,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NModal,
  NSpace,
  NTag,
  NTooltip,
  useDialog,
  useMessage,
  type MenuOption,
} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import SegmentedControl from '../components/SegmentedControl.vue';
import PageHeader from '../components/PageHeader.vue';
import TableSkeleton from '../components/TableSkeleton.vue';
import { api, type DataResponse } from '../api';
import { tick } from '../autoRefresh';
import { useCopy } from '../clipboard';
import { STATUS_META, fmtTime, num, relTime } from '../format';
import { refreshKeys, store } from '../store';
import type { KeyQuota, KeySummary, Region } from '../types';

const message = useMessage();
const dialog = useDialog();

const keyword = ref('');
const busyId = ref('');

const secret = ref<{ name: string; plaintext: string } | null>(null);
/** 列表复制失败时的兜底弹窗 */
const showManualCopy = ref(false);
const manualCopy = ref<{ name: string; plaintext: string } | null>(null);

/** 编辑弹窗：一次承载全部可改项，避免为每个字段开一个弹窗 */
const showEdit = ref(false);
const editTarget = ref<KeySummary | null>(null);
const editForm = ref({
  name: '',
  enabled: true,
  credentialIds: [] as string[],
  modelIds: [] as string[],
  // null 表示「未设置该项」——NInputNumber 的空态就是 null，
  // 与 0（有效的「立即禁用」）语义不同，不能混用
  quota: {
    dailyRequests: null as number | null,
    monthlyRequests: null as number | null,
    dailyTokens: null as number | null,
    monthlyTokens: null as number | null,
    dailyCredit: null as number | null,
    monthlyCredit: null as number | null,
  },
});
const saving = ref(false);

/** 创建弹窗 */
const showCreate = ref(false);
const creating = ref(false);
const newKey = ref({ name: '', credentialIds: [] as string[] });

/** 模型别名编辑（沿用列表式编辑，增删行比手写 JSON 直观） */
const showAlias = ref(false);
const aliasTarget = ref<KeySummary | null>(null);
const aliasRows = ref<{ client: string; upstream: string }[]>([]);

/** 可绑定的模型清单：优先用上游实时目录，失败时退回已缓存的列表 */
const modelOptions = computed(() => {
  const ids = new Set<string>();
  for (const item of availableModels.value) ids.add(item);
  return [...ids].sort().map((id) => ({ id, label: id }));
});
const availableModels = ref<string[]>([]);

const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  if (!query) return store.keys;
  return store.keys.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(query));
});

/** 首屏加载中：refreshedAt === 0 才是真正的首屏，后台刷新不替换内容以免抖动 */
const firstLoad = computed(() => store.loading && store.refreshedAt === 0);

/** 概览统计：四个数字回答「整体用得怎么样」 */
const overview = computed(() => {
  const keys = store.keys;
  const enabled = keys.filter((k) => k.enabled).length;
  let todayRequests = 0;
  let todayTokens = 0;
  let limited = 0;
  for (const k of keys) {
    todayRequests += k.usage?.daily?.requests ?? 0;
    todayTokens += k.usage?.daily?.tokens ?? 0;
    if (k.quota && Object.keys(k.quota).length > 0) limited += 1;
  }
  return { total: keys.length, enabled, todayRequests, todayTokens, limited };
});

// ── 展示辅助 ────────────────────────────────────────────────────────────

function boundNames(key: KeySummary): string {
  if (!key.credentialIds.length) return '未绑定';
  return key.credentialIds
    .map((id) => store.credentials.find((cred) => cred.id === id)?.name ?? id)
    .join('、');
}

/** 绑定的凭证里有几个不健康：一眼看出这个 Key 的可用性风险 */
function boundWarnings(key: KeySummary): number {
  return key.credentialIds.filter(
    (id) => store.credentials.find((cred) => cred.id === id)?.status !== 'healthy',
  ).length;
}

function modelBindingLabel(key: KeySummary): string {
  const list = key.modelIds ?? [];
  return list.length === 0 ? '全部模型' : `${list.length} 个模型`;
}

function fmtTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

/** 配额进度项（只列出已设置的维度，未设置的不占位置） */
interface QuotaBar {
  label: string;
  used: number;
  limit: number;
  percent: number;
  tone: 'ok' | 'warn' | 'bad';
}

function quotaBars(key: KeySummary): QuotaBar[] {
  const q = key.quota ?? {};
  const u = key.usage;
  const defs: Array<[string, number | undefined, number]> = [
    ['今日请求', q.dailyRequests, u?.daily?.requests ?? 0],
    ['本月请求', q.monthlyRequests, u?.monthly?.requests ?? 0],
    ['今日 Token', q.dailyTokens, u?.daily?.tokens ?? 0],
    ['本月 Token', q.monthlyTokens, u?.monthly?.tokens ?? 0],
    ['今日积分', q.dailyCredit, u?.daily?.credit ?? 0],
    ['本月积分', q.monthlyCredit, u?.monthly?.credit ?? 0],
  ];
  return defs
    .filter(([, limit]) => typeof limit === 'number' && limit >= 0)
    .map(([label, limit, used]) => {
      const cap = limit as number;
      const percent = cap === 0 ? 100 : Math.min(100, Math.round((used / cap) * 100));
      // 分级阈值：≥100% 红、≥80% 黄，便于提前预警
      const tone: QuotaBar['tone'] = percent >= 100 ? 'bad' : percent >= 80 ? 'warn' : 'ok';
      return { label, used, limit: cap, percent, tone };
    });
}

// ── 操作 ────────────────────────────────────────────────────────────────

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
    await api(`/admin/api/keys/${encodeURIComponent(row.id)}`, {
      method: 'PUT',
      body: { enabled: !row.enabled },
    });
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

function doResetUsage(row: KeySummary): void {
  dialog.warning({
    title: '重置用量',
    content: `将「${row.name}」的今日与本月用量计数清零（配额策略保留）。`,
    positiveText: '重置',
    negativeText: '取消',
    onPositiveClick: () =>
      run(row.id, '重置用量', async () => {
        await api(`/admin/api/keys/${encodeURIComponent(row.id)}/reset-usage`, { method: 'POST' });
        message.success('用量已重置');
        await refreshKeys();
      }),
  });
}

/**
 * 低频操作的更多菜单。
 *
 * 极简口径下每行只保留两个高频动作（编辑 / 别名），
 * 重置用量、启用停用、删除收进菜单 —— 它们要么危险、要么很少用。
 */
function keyMenu(row: KeySummary): MenuOption[] {
  return [
    { label: '重置用量', key: 'reset' },
    { label: row.enabled ? '停用' : '启用', key: 'toggle' },
    { type: 'divider', key: 'd1' },
    { label: '删除', key: 'delete' },
  ];
}

function onKeyMenu(row: KeySummary, key: string): void {
  if (key === 'reset') doResetUsage(row);
  else if (key === 'toggle') void doToggle(row);
  else if (key === 'delete') doDelete(row);
}

/** 打开编辑弹窗，把现有配置铺进表单 */
function openEdit(row: KeySummary): void {
  editTarget.value = row;
  const q = row.quota ?? {};
  const asField = (v: number | undefined): number | null => (typeof v === 'number' ? v : null);
  editForm.value = {
    name: row.name,
    enabled: row.enabled,
    credentialIds: [...row.credentialIds],
    modelIds: [...(row.modelIds ?? [])],
    quota: {
      dailyRequests: asField(q.dailyRequests),
      monthlyRequests: asField(q.monthlyRequests),
      dailyTokens: asField(q.dailyTokens),
      monthlyTokens: asField(q.monthlyTokens),
      dailyCredit: asField(q.dailyCredit),
      monthlyCredit: asField(q.monthlyCredit),
    },
  };
  showEdit.value = true;
}

/** 把表单里的 null 转成「未设置」；数字则保留（含 0，0 是有效的「立即禁用」） */
function quotaFromForm(form: typeof editForm.value.quota): KeyQuota {
  const out: KeyQuota = {};
  for (const key of Object.keys(form) as Array<keyof typeof form>) {
    const raw = form[key];
    if (raw === null || raw === undefined) continue;
    if (Number.isFinite(raw) && raw >= 0) out[key] = Math.floor(raw);
  }
  return out;
}

async function submitEdit(): Promise<void> {
  const target = editTarget.value;
  if (!target) return;
  const name = editForm.value.name.trim();
  if (!name) {
    message.error('请填写名称');
    return;
  }

  saving.value = true;
  try {
    await api(`/admin/api/keys/${encodeURIComponent(target.id)}`, {
      method: 'PUT',
      body: {
        name,
        enabled: editForm.value.enabled,
        credentialIds: editForm.value.credentialIds,
        modelIds: editForm.value.modelIds,
        quota: quotaFromForm(editForm.value.quota),
      },
    });
    message.success('已保存');
    showEdit.value = false;
    await refreshKeys();
  } catch (err) {
    message.error(`保存失败：${(err as Error).message}`);
  } finally {
    saving.value = false;
  }
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

function toggleIn(list: string[], id: string, checked: boolean): string[] {
  return checked ? [...list, id] : list.filter((item) => item !== id);
}

/** 复制到剪贴板（明文 Key 只显示一次，提示里点明复制到了什么） */
const copy = useCopy();

/**
 * 关闭明文弹窗前的二次确认。
 *
 * 明文只下发一次，误关即永久丢失（只能删掉重建 Key）。此前点遮罩/ESC
 * 就直接置 null，用户反馈「创建后无法再次复制」——实际是一关就没了。
 * 现在必须显式确认才能关闭，把「不可逆」这件事挡在动作之前。
 */
/**
 * 复制明文；失败时自动全选输入框内容。
 *
 * 明文只在这一次出现，复制失败必须给出**可立即执行的补救**，
 * 而不是只弹一句提示让用户自己想办法。全选后用户按 Ctrl+C 即可。
 */
async function copyKeyPlaintext(): Promise<void> {
  const text = secret.value?.plaintext ?? '';
  const ok = await copy(text, '已复制 Key');
  if (!ok) {
    const el = document.querySelector<HTMLInputElement>('.secret');
    el?.focus();
    el?.select();
  }
}

/**
 * 复制列表里某个 Key 的明文（明文由服务端解密随列表下发）。
 *
 * 复制失败时把明文放进一个自动全选的只读输入框并弹出 —— 列表里的明文
 * 不像创建弹窗那样有现成的输入框可全选，若不兜底，用户就只能看到
 * 一句「复制失败」而拿不到值。弹窗形式保证任何环境下都能手动取走。
 */
async function copyKey(key: KeySummary): Promise<void> {
  if (!key.plaintext) return;
  const ok = await copy(key.plaintext, `已复制 ${key.name} 的 Key`);
  if (ok) return;
  manualCopy.value = { name: key.name, plaintext: key.plaintext };
  showManualCopy.value = true;
}

function onSecretModalToggle(show: boolean): void {
  if (show || !secret.value) return;
  dialog.warning({
    title: '关闭后明文将无法再次查看',
    content: '该 Key 的明文只下发一次。请确认已复制或下载 .env 片段。',
    positiveText: '我已保存，关闭',
    negativeText: '返回查看',
    onPositiveClick: () => { secret.value = null; },
  });
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

/**
 * 拉取可绑定模型清单（用于编辑弹窗的模型多选）。
 *
 * 必须走 /admin/api/models 而非 /v1/models：后者面向 API 客户端、要求网关 Key，
 * 管理台的 cookie 会话请求它会得到 401，而 api.ts 对 401 的处理是整页跳转
 * /admin —— 表现为「一打开 Key 页面就被弹回总览」。
 *
 * `region` 选择看哪个上游的目录：两个区域的模型 ID 不重叠（国内版含混元系
 * 模型，国际版未必提供），混在一起会让绑定失去意义。
 */
async function loadModels(): Promise<void> {
  try {
    const res = await api<{ data?: Array<{ id: string }> }>(
      `/admin/api/models?region=${modelRegion.value}`,
    );
    const ids = (res.data ?? []).map((m) => m.id).filter(Boolean);
    availableModels.value = ids;
  } catch {
    // 拉取失败不阻塞页面：模型绑定退化为「只能填已知清单」，配额与统计仍可用
    availableModels.value = [];
  }
}

/** 模型目录所属区域；切换后重新拉取（影响下方模型多选的候选项） */
const modelRegion = ref<Region>('cn');

/**
 * 分段控件的双向绑定代理。
 *
 * SegmentedControl 只给 v-model，不给 change 事件；这里用 setter 侦测到
 * 值变化后触发重新拉取，让「切换区域 → 换目录」在 UI 上成为一个原子操作，
 * 而不需要额外加一个「刷新」按钮。
 */
const modelRegionProxy = computed<Region>({
  get: () => modelRegion.value,
  set: (next) => {
    if (next === modelRegion.value) return;
    modelRegion.value = next;
    void loadModels();
  },
});

watch(tick, () => void refreshKeys());

onMounted(() => {
  void refreshKeys();
  void loadModels();
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="API Keys" desc="客户端持有网关 Key；上游凭证由网关调度与刷新">
      <NButton secondary :loading="store.loading" @click="refreshKeys">
        <template #icon><AppIcon name="refresh" :size="15" /></template>
        刷新
      </NButton>
      <NButton type="primary" @click="showCreate = true">
        <template #icon><AppIcon name="plus" :size="15" /></template>
        创建 Key
      </NButton>
    </PageHeader>

    <!-- 概览读数带：4 个数字回答「整体用得怎么样」，用发丝竖线分隔 -->
    <section v-if="!firstLoad && store.keys.length > 0" class="stats" aria-label="Key 概览">
      <div class="stat">
        <div class="stat-k label">Key 总数</div>
        <div class="stat-v">{{ overview.total }}</div>
        <div class="stat-d">{{ overview.enabled }} 个启用中</div>
      </div>
      <div class="stat">
        <div class="stat-k label">今日请求</div>
        <div class="stat-v">{{ num(overview.todayRequests) }}</div>
        <div class="stat-d">全部 Key 合计</div>
      </div>
      <div class="stat">
        <div class="stat-k label">今日 Token</div>
        <div class="stat-v">{{ fmtTokens(overview.todayTokens) }}</div>
        <div class="stat-d">上游上报口径</div>
      </div>
      <div class="stat">
        <div class="stat-k label">已设配额</div>
        <div class="stat-v">{{ overview.limited }}</div>
        <div class="stat-d">其余不限量</div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title">客户端 Key</div>
        <div class="panel-head-extra">
          <span class="sub">共 {{ filtered.length }} 个</span>
          <NInput
            v-model:value="keyword"
            placeholder="搜索名称或 ID"
            clearable
            size="small"
            style="width: 220px"
          >
            <template #prefix><AppIcon name="search" :size="14" /></template>
          </NInput>
        </div>
      </div>

      <TableSkeleton v-if="firstLoad" :widths="[1.2, 1.6, 0.8, 0.8]" :rows="4" />

      <div v-else-if="filtered.length === 0">
        <EmptyState
          icon="keys"
          title="还没有客户端 Key"
          desc="创建 Key 并绑定上游凭证后即可调用网关（明文仅显示一次）。"
        >
          <NButton type="primary" size="small" @click="showCreate = true">创建 Key</NButton>
        </EmptyState>
      </div>

      <!-- 极简口径：每个 Key 不再是一张「白卡 + 阴影 + 内部分区」，
           而是一行「标识 → 用量占比 → 配额 → 元信息」，操作悬停浮现。
           Key 之间靠发丝线分隔，一屏能看到更多、对比也更容易。 -->
      <div v-else class="rows">
        <article v-for="key in filtered" :key="key.id" class="key-row" :class="{ off: !key.enabled }">
          <div class="ident">
            <div class="name">
              {{ key.name }}
              <span v-if="!key.enabled" class="sub">（已停用）</span>
            </div>
            <div class="cell-sub">
              <span class="kind">{{ boundNames(key) }}</span>
              <template v-if="boundWarnings(key) > 0">
                <span class="warn"> · {{ boundWarnings(key) }} 个异常</span>
              </template>
              <template v-if="Object.keys(key.modelAliases ?? {}).length">
                · {{ Object.keys(key.modelAliases ?? {}).length }} 条别名
              </template>
            </div>
          </div>

          <!-- 用量：今日 / 本月，等宽数字对齐 -->
          <div class="usage">
            <div class="usage-line">
              <span class="label">今日</span>
              <span class="tnum">{{ num(key.usage?.daily?.requests ?? 0) }} 次</span>
              <span class="tnum sub">{{ fmtTokens(key.usage?.daily?.tokens ?? 0) }} tok</span>
            </div>
            <div class="usage-line">
              <span class="label">本月</span>
              <span class="tnum">{{ num(key.usage?.monthly?.requests ?? 0) }} 次</span>
              <span class="tnum sub">{{ fmtTokens(key.usage?.monthly?.tokens ?? 0) }} tok</span>
            </div>
          </div>

          <!-- 配额：只显示已设置的维度；用 2px 细线表达占比 -->
          <div class="quota">
            <template v-if="quotaBars(key).length > 0">
              <div v-for="bar in quotaBars(key)" :key="bar.label" class="quota-item">
                <div class="quota-top">
                  <span class="label">{{ bar.label }}</span>
                  <span class="tnum sub">{{ num(bar.used) }} / {{ num(bar.limit) }}</span>
                </div>
                <div class="track">
                  <div class="fill" :class="bar.tone" :style="{ width: bar.percent + '%' }" />
                </div>
              </div>
            </template>
            <span v-else class="sub">未设配额</span>
          </div>

          <div class="meta">
            <NTooltip>
              <template #trigger>
                <span class="sub">{{ key.lastUsedAt ? relTime(key.lastUsedAt) : '尚未使用' }}</span>
              </template>
              <div>创建于 {{ fmtTime(key.createdAt) }}</div>
              <div v-if="key.lastUsedAt">最近使用 {{ fmtTime(key.lastUsedAt) }}</div>
            </NTooltip>
          </div>

          <!-- 操作：常显（可见性优先于版面清爽，见 styles.css 的 .row-acts） -->
          <div class="row-acts">
            <!-- 复制：明文由服务端解密随列表下发。存量 Key 无密文时 disabled，
                 用 title 说明原因，而不是给一个点了没反应的按钮。 -->
            <NButton
              size="tiny"
              quaternary
              :disabled="!key.plaintext"
              :title="key.plaintext ? '复制该 Key 的明文' : '该 Key 创建于加密存储之前，无法回显明文；可重置密钥后获得新明文'"
              @click="copyKey(key)"
            >
              复制
            </NButton>
            <NButton size="tiny" quaternary :loading="busyId === key.id" @click="openEdit(key)">编辑</NButton>
            <NButton size="tiny" quaternary @click="openAlias(key)">别名</NButton>
            <NDropdown
              :options="keyMenu(key)"
              @select="(k: string) => onKeyMenu(key, k)"
              trigger="click"
            >
              <NButton size="tiny" quaternary>更多</NButton>
            </NDropdown>
          </div>
        </article>
      </div>
    </section>

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
        <div class="sub">模型与配额可在创建后用「编辑」配置；默认不限制。</div>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton :disabled="creating" @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="submitCreate">创建</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 编辑 Key：名称 / 状态 / 凭证 / 模型 / 配额 -->
    <NModal
      v-model:show="showEdit"
      preset="card"
      :title="`编辑「${editTarget?.name ?? ''}」`"
      style="width: min(600px, calc(100vw - 32px))"
      :mask-closable="!saving"
    >
      <NForm label-placement="top">
        <div class="form-row">
          <NFormItem label="名称">
            <NInput v-model:value="editForm.name" placeholder="Key 名称" />
          </NFormItem>
          <NFormItem label="状态">
            <NCheckbox
              :checked="editForm.enabled"
              @update:checked="(v: boolean) => (editForm.enabled = v)"
            >
              启用
            </NCheckbox>
          </NFormItem>
        </div>

        <NFormItem label="绑定上游凭证">
          <div class="cred-list">
            <NCheckbox
              v-for="cred in store.credentials"
              :key="cred.id"
              :checked="editForm.credentialIds.includes(cred.id)"
              @update:checked="(checked: boolean) => (editForm.credentialIds = toggleIn(editForm.credentialIds, cred.id, checked))"
            >
              {{ cred.name }}
              <span class="sub">（{{ STATUS_META[cred.status]?.label ?? cred.status }}）</span>
            </NCheckbox>
            <span v-if="store.credentials.length === 0" class="sub">尚无上游凭证</span>
          </div>
        </NFormItem>

        <NFormItem label="可用的模型（全部不勾选 = 不限制，即全部模型可用）">
          <div class="model-region-bar">
            <SegmentedControl
              v-model="modelRegionProxy"
              label="区域"
              :options="[
                { value: 'cn', label: '国内版' },
                { value: 'intl', label: '国际版' },
              ]"
            />
            <span class="sub">按上游区域选择模型目录，两个区域的模型 ID 不通用</span>
          </div>
          <div class="model-list">
            <NCheckbox
              v-for="option in modelOptions"
              :key="option.id"
              :checked="editForm.modelIds.includes(option.id)"
              @update:checked="(checked: boolean) => (editForm.modelIds = toggleIn(editForm.modelIds, option.id, checked))"
            >
              {{ option.label }}
            </NCheckbox>
            <span v-if="modelOptions.length === 0" class="sub">
              未能获取模型列表（可稍后重试，或先用默认的「全部模型」）
            </span>
          </div>
        </NFormItem>

        <NFormItem label="配额（留空 = 该维度不限量）">
          <div class="quota-form">
            <div class="quota-form-head">
              <span />
              <span class="sub">每日</span>
              <span class="sub">每月</span>
            </div>
            <div class="quota-form-row">
              <span class="k">请求数</span>
              <NInputNumber
                v-model:value="editForm.quota.dailyRequests"
                :min="0"
                :show-button="false"
                placeholder="不限"
                size="small"
              />
              <NInputNumber
                v-model:value="editForm.quota.monthlyRequests"
                :min="0"
                :show-button="false"
                placeholder="不限"
                size="small"
              />
            </div>
            <div class="quota-form-row">
              <span class="k">Token</span>
              <NInputNumber
                v-model:value="editForm.quota.dailyTokens"
                :min="0"
                :show-button="false"
                placeholder="不限"
                size="small"
              />
              <NInputNumber
                v-model:value="editForm.quota.monthlyTokens"
                :min="0"
                :show-button="false"
                placeholder="不限"
                size="small"
              />
            </div>
            <div class="quota-form-row">
              <span class="k">积分</span>
              <NInputNumber
                v-model:value="editForm.quota.dailyCredit"
                :min="0"
                :show-button="false"
                placeholder="不限"
                size="small"
              />
              <NInputNumber
                v-model:value="editForm.quota.monthlyCredit"
                :min="0"
                :show-button="false"
                placeholder="不限"
                size="small"
              />
            </div>
          </div>
        </NFormItem>
        <div class="sub">
          配额按日/月自然窗口滚动，超限后客户端请求会被拒绝（HTTP 429），
          直到下一个窗口开始。
        </div>
      </NForm>

      <template #footer>
        <NSpace justify="end">
          <NButton :disabled="saving" @click="showEdit = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="submitEdit">保存</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 模型别名 -->
    <NModal
      v-model:show="showAlias"
      preset="card"
      :title="`模型别名 · ${aliasTarget?.name ?? ''}`"
      style="width: min(560px, calc(100vw - 32px))"
    >
      <div class="sub" style="margin-bottom: 12px">
        客户端发送左侧名称时，网关转发前重写为右侧的真实上游模型。
        用于让 Cline / Continue 等按模型 ID 匹配内置目录的客户端，
        也能获得正确的上下文长度与输出上限。
      </div>
      <div class="alias-rows">
        <div v-for="(row, index) in aliasRows" :key="index" class="alias-row">
          <NSelect
            v-model:value="row.client"
            :options="modelOptions"
            filterable
            tag
            placeholder="客户端发送的名称"
            size="small"
          />
          <AppIcon name="arrow-right" :size="14" />
          <NSelect
            v-model:value="row.upstream"
            :options="modelOptions"
            filterable
            tag
            placeholder="上游真实模型"
            size="small"
          />
          <NButton quaternary size="tiny" @click="removeAliasRow(index)">
            <template #icon><AppIcon name="trash" :size="13" /></template>
          </NButton>
        </div>
      </div>
      <NButton quaternary size="small" style="margin-top: 10px" @click="addAliasRow">
        <template #icon><AppIcon name="plus" :size="14" /></template>
        添加一条
      </NButton>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="showAlias = false">取消</NButton>
          <NButton type="primary" @click="submitAlias">保存</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 明文（仅一次）+ 接入片段 -->
    <NModal
      :show="!!secret"
      preset="card"
      title="Key 创建成功"
      style="width: min(640px, calc(100vw - 32px))"
      :mask-closable="false"
      :close-on-esc="false"
      @update:show="onSecretModalToggle"
    >
      <div class="warn">请立即保存。出于安全，明文仅显示这一次。</div>
      <!-- 用只读输入框而非普通文本：点一下即全选，两种复制都失败时用户还能手动 Ctrl+C。
           普通 div 需要用户自己拖选，长 Key 很容易漏掉首尾字符。 -->
      <input
        class="secret mono"
        readonly
        :value="secret?.plaintext ?? ''"
        aria-label="API Key 明文"
        @focus="(e: FocusEvent) => (e.target as HTMLInputElement).select()"
        @click="(e: MouseEvent) => (e.target as HTMLInputElement).select()"
      />
      <div class="secret-actions">
        <NButton size="small" secondary @click="copyKeyPlaintext">
          <template #icon><AppIcon name="copy" :size="14" /></template>
          复制 Key
        </NButton>
        <NButton size="small" secondary @click="copy(envSnippet, '已复制接入片段')">
          <template #icon><AppIcon name="copy" :size="14" /></template>
          复制 .env 片段
        </NButton>
        <NButton size="small" secondary @click="downloadEnv">
          <template #icon><AppIcon name="download" :size="14" /></template>
          下载
        </NButton>
      </div>
    </NModal>

    <!-- 复制失败兜底：把明文放进自动全选的只读输入框，任何环境下都能手动取走 -->
    <NModal
      v-model:show="showManualCopy"
      preset="card"
      title="手动复制"
      style="width: min(640px, calc(100vw - 32px))"
      @after-leave="manualCopy = null"
    >
      <div class="sub" style="margin-bottom: 12px">
        自动复制在当前环境不可用（常见于局域网明文 HTTP）。点下方输入框已自动全选，
        按 Ctrl/Cmd + C 即可复制。
      </div>
      <input
        class="secret mono"
        readonly
        :value="manualCopy?.plaintext ?? ''"
        aria-label="API Key 明文"
        @focus="(e: FocusEvent) => (e.target as HTMLInputElement).select()"
        @click="(e: MouseEvent) => (e.target as HTMLInputElement).select()"
      />
      <template #footer>
        <NSpace justify="end">
          <NButton type="primary" @click="showManualCopy = false">关闭</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
/* ── Key 行 ──
   每个 Key 一行：标识 → 用量 → 配额 → 元信息 → 操作。
   靠发丝线分隔，不用卡片 —— 一屏能看到更多，对比也更容易。 */
.rows {
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
}

.key-row {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) 180px minmax(160px, 1fr) 96px auto;
  align-items: center;
  gap: 24px;
  padding: 15px 0;
  border-bottom: 1px solid var(--line);
  transition: background 140ms var(--ease);
}

.key-row:last-child {
  border-bottom: none;
}

.key-row:hover {
  background: rgba(0, 0, 0, 0.014);
}

.key-row.off {
  opacity: 0.55;
}

.ident {
  min-width: 0;
}

.name {
  font-weight: 550;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.usage-line {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 12px;
}

.usage-line .label {
  width: 26px;
  flex: none;
}

.quota {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.quota-item {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.quota-top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}

/* 2px 细线：配额只需表达比例，不需要视觉重量 */
.track {
  height: 2px;
  background: var(--line);
  overflow: hidden;
}

.fill {
  height: 100%;
  background: var(--text);
  transition: width 480ms var(--ease);
}

.fill.warn {
  background: var(--warn);
}

.fill.bad {
  background: var(--bad);
}

.meta {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
}

@media (max-width: 1100px) {
  .key-row {
    grid-template-columns: 1fr 1fr;
    gap: 14px 24px;
    align-items: start;
  }

  .meta {
    grid-column: 1 / -1;
  }
}

@media (max-width: 640px) {
  .key-row {
    grid-template-columns: 1fr;
  }

  .row-acts {
    justify-content: flex-start;
  }

  .quota-form-head,
  .quota-form-row {
    grid-template-columns: 60px 1fr 1fr;
    gap: 6px;
  }
}

/* ── 编辑弹窗内的表单块 ──
   以下 9 个类在极简改版重写样式时被整体删掉了（模板仍在用），
   导致编辑弹窗的排版完全失效：名称与状态挤在一起、凭证/模型列表
   没有高度上限会无限撑长、配额三列表格塌成一列。此处按原设计补回，
   并统一到极简令牌。 */

/* 名称 + 状态并排 */
.form-row {
  display: grid;
  gap: 12px;
  grid-template-columns: 1fr auto;
  align-items: start;
}

/* 绑定凭证 / 可用模型：可滚动的复选列表，限高避免弹窗被撑长 */
.cred-list,
.model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow: auto;
  width: 100%;
}

.model-list {
  max-height: 200px;
}

/* 模型目录的区域切换条 */
.model-region-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

/* 配额：日 / 月 三列表格（维度名 + 每日 + 每月） */
.quota-form {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.quota-form-head,
.quota-form-row {
  display: grid;
  grid-template-columns: 72px 1fr 1fr;
  gap: 10px;
  align-items: center;
}

.quota-form-row .k {
  font-size: 12.5px;
  color: var(--text-2);
}

/* 模型别名：客户端名 → 上游名，中间一个箭头 */
.alias-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── 弹窗内的键值 / 表单块 ── */
.kv {
  list-style: none;
  margin: 0;
  padding: 0;
}

.kv li {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 0;
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
}

.kv li:last-child {
  border-bottom: none;
}

.kv span {
  color: var(--text-3);
}

.kv b {
  font-weight: 550;
  text-align: right;
  word-break: break-all;
}

/* 密钥明文：只读输入框，点一下全选 —— 复制失败时仍可手动 Ctrl+C */
.secret {
  display: block;
  width: 100%;
  padding: 12px;
  background: var(--surface-2);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 12.5px;
  word-break: break-all;
  color: var(--text);
  cursor: text;
}

.secret:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.secret-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.warn {
  border-left: 2px solid var(--warn);
  padding: 2px 0 2px 14px;
  color: var(--warn);
  font-size: 12.5px;
  line-height: 1.7;
  margin-bottom: 16px;
}

/* 模型别名表格 */
.alias-row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.alias-arrow {
  flex: none;
  color: var(--text-3);
}

@media (max-width: 640px) {
  .cards {
    grid-template-columns: 1fr;
  }
}
</style>
