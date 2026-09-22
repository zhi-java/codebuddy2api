<script setup lang="ts">
/**
 * 上游凭证：凭证池的日常运维。
 *
 * 交互按真实运维动线组织：
 *   状态摘要（点选过滤）→ 搜索/筛选 → 表格（行内主操作 + 「更多」菜单）
 *   → 额度抽屉（进度条读数）→ 批量测试/启停。
 * 自动签到开关也在这里（用户要求：签到与凭证管理同屏）。
 */
import { computed, h, onMounted, ref, watch } from 'vue';
import {
  NButton,
  NCard,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NEmpty,
  NForm,
  NFormItem,
  NInput,
  NModal,
  NPopover,
  NProgress,
  NSelect,
  NSpace,
  NSwitch,
  NTag,
  NTooltip,
  useDialog,
  useMessage,
  type DataTableColumns,
  type DataTableRowKey,
} from 'naive-ui';
import AppIcon from '../components/AppIcon.vue';
import EmptyState from '../components/EmptyState.vue';
import PageHeader from '../components/PageHeader.vue';
import TableSkeleton from '../components/TableSkeleton.vue';
import { api, type DataResponse } from '../api';
import { tick } from '../autoRefresh';
import { KIND_NAME, STATUS_META, fmtTime, num, relTime } from '../format';
import { loadSettings, refreshCredentials, saveSettings, store } from '../store';
import type { CheckinStatus, CredentialSummary, CredentialStatus, QuotaInfo } from '../types';

const message = useMessage();
const dialog = useDialog();

/** 主签到时点（scheduled.ts 的 UTC 03:17），同时标出北京时间便于国内运维对照 */
const CHECKIN_TIME = 'UTC 03:17（北京时间 11:17）';

const keyword = ref('');
const statusFilter = ref<CredentialStatus | 'all'>('all');
const busyId = ref('');
const selected = ref<DataTableRowKey[]>([]);

const showCreate = ref(false);
const creating = ref(false);
const form = ref({ name: '', kind: 'ck_apikey' as 'ck_apikey' | 'cli_oauth', token: '', refreshToken: '' });

const autoCheckin = ref(false);
const savingCheckin = ref(false);

const quotaOpen = ref(false);
const quotaLoading = ref(false);
const quotaTarget = ref<CredentialSummary | null>(null);
const quota = ref<QuotaInfo | null>(null);

const checkinOpen = ref(false);
const checkinLoading = ref(false);
const checkinTarget = ref<CredentialSummary | null>(null);
const checkinStatus = ref<CheckinStatus | null>(null);

const kindOptions = [
  { label: '控制台 API Key（ck_ 开头，不会过期）', value: 'ck_apikey' },
  { label: 'CLI OAuth（accessToken，可自动刷新）', value: 'cli_oauth' },
];

/** 状态摘要 chips：既是统计也是过滤器 */
const summary = computed(() => {
  const list = store.credentials;
  const count = (status: CredentialStatus) => list.filter((item) => item.status === status).length;
  return [
    { key: 'all' as const, label: '全部', value: list.length },
    { key: 'healthy' as const, label: '健康', value: count('healthy') },
    { key: 'error' as const, label: '异常', value: count('error') },
    { key: 'cooling' as const, label: '冷却中', value: count('cooling') },
    { key: 'expired' as const, label: '已过期', value: count('expired') },
    { key: 'disabled' as const, label: '已停用', value: count('disabled') },
  ];
});

const filtered = computed(() => {
  const query = keyword.value.trim().toLowerCase();
  return store.credentials.filter((item) => {
    if (statusFilter.value !== 'all' && item.status !== statusFilter.value) return false;
    if (!query) return true;
    return `${item.name} ${item.id}`.toLowerCase().includes(query);
  });
});

/**
 * 首屏加载中（尚未拿到任何一次基础数据）。
 *
 * 用 refreshedAt 而非 store.loading 判断：后者在**每次**后台自动刷新时都会置位，
 * 若据此隐藏表格，已加载好的数据会被周期性抽掉换成骨架，反而制造抖动。
 * refreshedAt 为 0 只可能是首次拉取，语义精确对应「首屏」。
 */
const firstLoad = computed(() => store.loading && store.refreshedAt === 0);

function statusTag(row: CredentialSummary) {
  const meta = STATUS_META[row.status] ?? { label: '未知', type: 'default' as const };
  const tag = h(NTag, { size: 'small', bordered: false, type: meta.type }, { default: () => meta.label });
  if (!row.lastError) return tag;
  return h(
    NTooltip,
    { trigger: 'hover' },
    {
      trigger: () => tag,
      default: () => h('div', { style: 'max-width:320px;word-break:break-all' }, row.lastError as string),
    },
  );
}

function tokenReady(row: CredentialSummary): { ok: boolean; text: string } {
  if (row.kind === 'ck_apikey') return { ok: row.hasApiKey, text: row.hasApiKey ? '已配置' : '缺失' };
  const access = row.hasAccessToken;
  const refresh = row.hasRefreshToken;
  return { ok: access || refresh, text: `access ${access ? '✓' : '✗'} · refresh ${refresh ? '✓' : '✗'}` };
}

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

async function openQuota(row: CredentialSummary): Promise<void> {
  quotaTarget.value = row;
  quota.value = null;
  quotaOpen.value = true;
  quotaLoading.value = true;
  try {
    const res = await api<DataResponse<QuotaInfo>>(`/admin/api/credentials/${encodeURIComponent(row.id)}/quota`);
    quota.value = res.data ?? {};
  } catch (err) {
    message.error(`额度查询失败：${(err as Error).message}`);
  } finally {
    quotaLoading.value = false;
  }
}

/** 额度进度：优先用接口给出的 remaining/total，缺失时按 used/total 反推 */
const quotaPercent = computed(() => {
  const data = quota.value;
  if (!data || !data.total) return null;
  const remaining = typeof data.remaining === 'number' ? data.remaining : (data.total ?? 0) - (data.used ?? 0);
  return Math.max(0, Math.min(100, Math.round((remaining / data.total) * 100)));
});

/** 签到活动状态抽屉：只读查询，展示期次/连续天数/累计积分 */
async function openCheckin(row: CredentialSummary): Promise<void> {
  checkinTarget.value = row;
  checkinStatus.value = null;
  checkinOpen.value = true;
  checkinLoading.value = true;
  try {
    const res = await api<DataResponse<CheckinStatus>>(
      `/admin/api/credentials/${encodeURIComponent(row.id)}/checkin-status`,
    );
    checkinStatus.value = res.data ?? null;
  } catch (err) {
    message.error(`签到状态查询失败：${(err as Error).message}`);
  } finally {
    checkinLoading.value = false;
  }
}

/** 本期剩余天数（活动档期由上游下发，如第 8 期「开学季」至 09-15） */
const checkinDaysLeft = computed(() => {
  const end = checkinStatus.value?.endTime;
  if (!end) return null;
  const ts = Date.parse(end.replace(' ', 'T'));
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.ceil((ts - Date.now()) / 86_400_000));
});

async function doCheckin(row: CredentialSummary): Promise<void> {
  dialog.warning({
    title: '每日签到',
    content: `将对上游账号「${row.name}」执行每日签到（Buddy 加油站，每日 100 credits），确认继续？`,
    positiveText: '继续',
    negativeText: '取消',
    onPositiveClick: () =>
      run(row.id, '签到', async () => {
        const res = await api<DataResponse<{ credit?: number; streakDays?: number; message?: string; status?: CheckinStatus }>>(
          `/admin/api/credentials/${encodeURIComponent(row.id)}/checkin`,
          { method: 'POST' },
        );
        const data = res.data ?? {};
        if (data.credit && data.credit > 0) {
          message.success(`签到成功：+${data.credit} credits（连续 ${data.streakDays} 天）`);
        } else {
          message.info(data.message ?? '签到完成');
        }
        // 若抽屉正打开着该凭证，同步刷新状态
        if (checkinOpen.value && checkinTarget.value?.id === row.id) {
          checkinStatus.value = data.status ?? checkinStatus.value;
        }
      }),
  });
}

async function doRefresh(row: CredentialSummary): Promise<void> {
  await run(row.id, '刷新', async () => {
    await api(`/admin/api/credentials/${encodeURIComponent(row.id)}/refresh`, { method: 'POST' });
    message.success('已触发刷新');
    await refreshCredentials();
  });
}

async function doTest(row: CredentialSummary): Promise<void> {
  await run(row.id, '连通测试', async () => {
    const res = await api<{ ok?: boolean; status?: number }>('/admin/api/test', {
      method: 'POST',
      body: { credentialId: row.id },
    });
    if (res.ok) message.success(`${row.name} 连通正常`);
    else message.error(`${row.name} 上游返回 HTTP ${res.status}`);
  });
}

async function doToggle(row: CredentialSummary): Promise<void> {
  await run(row.id, '状态切换', async () => {
    await api(`/admin/api/credentials/${encodeURIComponent(row.id)}`, { method: 'PUT', body: { enabled: !row.enabled } });
    await refreshCredentials();
  });
}

function doDelete(row: CredentialSummary): void {
  dialog.warning({
    title: '删除凭证',
    content: `确认删除凭证「${row.name}」？绑定该凭证的 Key 将无法使用。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () =>
      run(row.id, '删除', async () => {
        await api(`/admin/api/credentials/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
        message.success('已删除');
        await refreshCredentials();
      }),
  });
}

/** 批量：对选中凭证依次执行动作(逐个反馈,避免一次性打满上游) */
async function batchTest(): Promise<void> {
  const targets = store.credentials.filter((item) => selected.value.includes(item.id));
  if (!targets.length) return;
  let ok = 0;
  for (const row of targets) {
    try {
      const res = await api<{ ok?: boolean; status?: number }>('/admin/api/test', {
        method: 'POST',
        body: { credentialId: row.id },
      });
      if (res.ok) ok += 1;
    } catch {
      // 单个失败不打断整批
    }
  }
  message.info(`已测试 ${targets.length} 个凭证：${ok} 个连通`);
  selected.value = [];
}

async function batchToggle(enabled: boolean): Promise<void> {
  const targets = store.credentials.filter((item) => selected.value.includes(item.id) && item.enabled !== enabled);
  if (!targets.length) {
    message.info('所选凭证无需变更');
    return;
  }
  for (const row of targets) {
    try {
      await api(`/admin/api/credentials/${encodeURIComponent(row.id)}`, { method: 'PUT', body: { enabled } });
    } catch {
      // 单个失败不打断整批
    }
  }
  message.success(`已${enabled ? '启用' : '停用'} ${targets.length} 个凭证`);
  selected.value = [];
  await refreshCredentials();
}

const rowMenu = (row: CredentialSummary) => [
  { label: '查看额度', key: 'quota' },
  { label: '签到状态', key: 'checkin-status' },
  { label: '立即签到', key: 'checkin' },
  { label: row.enabled ? '停用' : '启用', key: 'toggle' },
  { type: 'divider', key: 'd1' },
  { label: '删除凭证', key: 'delete' },
];

function onRowMenu(row: CredentialSummary, key: string): void {
  if (key === 'quota') void openQuota(row);
  else if (key === 'checkin-status') void openCheckin(row);
  else if (key === 'checkin') void doCheckin(row);
  else if (key === 'toggle') void doToggle(row);
  else if (key === 'delete') doDelete(row);
}

const columns = computed<DataTableColumns<CredentialSummary>>(() => [
  {
    type: 'selection',
    disabled: () => false,
  },
  {
    title: '名称 / ID',
    key: 'name',
    minWidth: 200,
    render: (row) =>
      h('div', null, [
        h('div', { style: 'font-weight:550' }, row.name),
        h('div', { class: 'mono sub' }, row.id),
      ]),
  },
  {
    title: '类型',
    key: 'kind',
    width: 112,
    render: (row) =>
      h(NTag, { size: 'small', bordered: false, type: row.kind === 'ck_apikey' ? 'default' : 'info' }, {
        default: () => KIND_NAME[row.kind] ?? row.kind,
      }),
  },
  { title: '状态', key: 'status', width: 96, render: statusTag },
  {
    title: '凭证材料',
    key: 'token',
    width: 160,
    render: (row) => {
      const info = tokenReady(row);
      return h('span', { class: info.ok ? 'sub' : 'sub bad' }, info.text);
    },
  },
  {
    title: '有效期',
    key: 'expiresAt',
    width: 168,
    render: (row) =>
      h('div', null, [
        h('div', null, fmtTime(row.expiresAt)),
        h('div', { class: 'sub' }, row.expiresAt ? relTime(row.expiresAt) : row.kind === 'ck_apikey' ? '不过期' : '—'),
      ]),
  },
  {
    title: '操作',
    key: 'actions',
    width: 168,
    align: 'right',
    render: (row) =>
      h(NSpace, { justify: 'end', size: 4, wrap: false }, {
        default: () => [
          h(
            NButton,
            { size: 'tiny', quaternary: true, loading: busyId.value === row.id, onClick: () => openQuota(row) },
            { default: () => '额度' },
          ),
          h(NButton, { size: 'tiny', quaternary: true, onClick: () => doTest(row) }, { default: () => '测试' }),
          h(
            NDropdown,
            { options: rowMenu(row), onSelect: (key: string) => onRowMenu(row, key), trigger: 'click' },
            { default: () => h(NButton, { size: 'tiny', quaternary: true }, { default: () => '更多' }) },
          ),
        ],
      }),
  },
]);

async function submitCreate(): Promise<void> {
  const name = form.value.name.trim();
  const token = form.value.token.trim();
  const refreshToken = form.value.refreshToken.trim();
  if (!name || (!token && !(form.value.kind === 'cli_oauth' && refreshToken))) {
    message.error('请填写名称与 token');
    return;
  }
  creating.value = true;
  try {
    const body: Record<string, unknown> = { name, kind: form.value.kind };
    if (form.value.kind === 'ck_apikey') body.apiKey = token;
    else {
      body.accessToken = token;
      body.refreshToken = refreshToken;
    }
    await api('/admin/api/credentials', { method: 'POST', body });
    message.success('凭证已添加');
    showCreate.value = false;
    form.value = { name: '', kind: 'ck_apikey', token: '', refreshToken: '' };
    await refreshCredentials();
  } catch (err) {
    message.error(`添加失败：${(err as Error).message}`);
  } finally {
    creating.value = false;
  }
}

async function toggleAutoCheckin(value: boolean): Promise<void> {
  savingCheckin.value = true;
  try {
    await saveSettings({ autoCheckin: value });
    message.success(value ? `已开启自动签到（${CHECKIN_TIME}）` : '已关闭自动签到');
    // 开关只控制是否自动执行；活动是否开放由上游按期下发，不在此处判断
  } catch (err) {
    autoCheckin.value = !value;
    message.error(`保存失败：${(err as Error).message}`);
  } finally {
    savingCheckin.value = false;
  }
}

watch(tick, () => void refreshCredentials());

onMounted(async () => {
  await refreshCredentials();
  const settings = await loadSettings();
  autoCheckin.value = settings.autoCheckin === true;
});
</script>

<template>
  <div class="page stack">
    <PageHeader title="上游凭证" desc="网关按健康度调度，失败自动切换">
      <NButton secondary :loading="store.loading" @click="refreshCredentials">
        <template #icon><AppIcon name="refresh" :size="15" /></template>
        刷新
      </NButton>
      <NButton type="primary" @click="showCreate = true">
        <template #icon><AppIcon name="plus" :size="15" /></template>
        添加上游凭证
      </NButton>
    </PageHeader>

    <!-- 状态摘要 chips：既是统计也是过滤器 -->
    <div class="summary">
      <button
        v-for="item in summary"
        :key="item.key"
        class="chip"
        :class="{ active: statusFilter === item.key }"
        :aria-pressed="statusFilter === item.key"
        @click="statusFilter = item.key"
      >
        <span class="chip-label">{{ item.label }}</span>
        <span class="chip-value tnum">{{ item.value }}</span>
      </button>
    </div>

    <section class="panel">
      <div class="panel-head">
        <!-- 计数不在此重复：上方 chips 的每一项（含「全部」）已带数量 -->
        <div class="panel-title">凭证池</div>

        <div class="panel-head-extra">
          <NInput v-model:value="keyword" placeholder="搜索凭证名称或 ID" clearable size="small" style="width: 220px">
            <template #prefix><AppIcon name="search" :size="14" /></template>
          </NInput>

          <template v-if="selected.length > 0">
            <span class="sub">已选 {{ selected.length }} 个</span>
            <NButton size="tiny" secondary @click="batchTest">批量测试</NButton>
            <NButton size="tiny" secondary @click="batchToggle(true)">启用</NButton>
            <NButton size="tiny" secondary @click="batchToggle(false)">停用</NButton>
            <NButton size="tiny" quaternary @click="selected = []">取消</NButton>
          </template>

          <span class="divider" />

          <div class="checkin-toggle">
            <span class="checkin-label">每日自动签到</span>
            <NPopover trigger="hover" placement="bottom-end" style="max-width: 320px">
              <template #trigger>
                <AppIcon name="help" :size="14" class="help-ico" />
              </template>
              每天 {{ CHECKIN_TIME }} 对全部启用凭证自动签到（Buddy 加油站，每日 100 credits）；
              未成功的按递增间隔补签，避免断签。关闭后仅保留行内「立即签到」。
            </NPopover>
            <NSwitch size="small" :value="autoCheckin" :loading="savingCheckin" @update:value="toggleAutoCheckin" />
          </div>
        </div>
      </div>

      <!-- 首屏用骨架替代整张表：既避免空框，也避免 #empty 的「还没有上游凭证」
           在已有数据时闪现一次（加载期间 data 为空会触发空态插槽） -->
      <TableSkeleton
        v-if="firstLoad"
        class="panel-body"
        :widths="[1.6, 2.4, 1.1, 1, 0.9, 0.7]"
        :rows="6"
      />

      <NDataTable
        v-else
        v-model:checked-row-keys="selected"
        :columns="columns"
        :data="filtered"
        :bordered="false"
        :single-line="false"
        size="small"
        :loading="store.loading"
        :row-key="(row: CredentialSummary) => row.id"
        :scroll-x="1100"
        :pagination="{ pageSize: 10 }"
      >
        <template #empty>
          <EmptyState
            icon="credentials"
            title="还没有上游凭证"
            desc="录入 ck_ 控制台 Key 或 CLI OAuth token 后，网关才能向上游出网。"
          >
            <NButton type="primary" size="small" @click="showCreate = true">添加上游凭证</NButton>
          </EmptyState>
        </template>
      </NDataTable>
    </section>

    <!-- 新增凭证 -->
    <NModal
      v-model:show="showCreate"
      preset="card"
      title="添加上游凭证"
      style="width: min(520px, calc(100vw - 32px))"
      :mask-closable="!creating"
    >
      <NForm label-placement="top">
        <NFormItem label="凭证名称">
          <NInput v-model:value="form.name" placeholder="例如：主账号 / 备用账号" />
        </NFormItem>
        <NFormItem label="类型">
          <NSelect v-model:value="form.kind" :options="kindOptions" />
        </NFormItem>
        <NFormItem :label="form.kind === 'cli_oauth' ? 'accessToken' : 'API Key'">
          <NInput
            v-model:value="form.token"
            class="mono"
            type="textarea"
            :rows="3"
            :placeholder="form.kind === 'cli_oauth' ? 'eyJhbGci…' : 'ck_xxxxx…'"
          />
        </NFormItem>
        <NFormItem v-if="form.kind === 'cli_oauth'" label="refreshToken（可选，用于自动刷新）">
          <NInput v-model:value="form.refreshToken" class="mono" type="textarea" :rows="3" placeholder="eyJhbGci…" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton :disabled="creating" @click="showCreate = false">取消</NButton>
          <NButton type="primary" :loading="creating" @click="submitCreate">保存</NButton>
        </NSpace>
      </template>
    </NModal>

    <!-- 额度抽屉 -->
    <NDrawer v-model:show="quotaOpen" :width="420" placement="right">
      <NDrawerContent :title="`额度 · ${quotaTarget?.name ?? ''}`" closable>
        <div v-if="quotaLoading" class="sub">查询中…</div>
        <template v-else-if="quota">
          <div v-if="quotaPercent !== null" class="quota">
            <NProgress
              type="line"
              :percentage="quotaPercent"
              :height="8"
              :show-indicator="false"
              :color="quotaPercent > 30 ? '#22c55e' : quotaPercent > 10 ? '#f59e0b' : '#ef4444'"
            />
            <div class="quota-nums">
              <span>剩余 {{ num(quota.remaining ?? (quota.total ?? 0) - (quota.used ?? 0)) }}</span>
              <span>共 {{ num(quota.total) }}</span>
            </div>
          </div>
          <ul class="kv">
            <li><span>总量</span><b>{{ num(quota.total) }}</b></li>
            <li><span>已用</span><b>{{ num(quota.used) }}</b></li>
            <li><span>计费周期</span><b>{{ quota.cycleStart || '—' }} ~ {{ quota.cycleEnd || '—' }}</b></li>
            <li v-if="quota.resourceId"><span>资源 ID</span><b class="mono">{{ quota.resourceId }}</b></li>
            <li><span>查询时间</span><b>{{ fmtTime(quota.checkedAt) }}</b></li>
          </ul>
        </template>
        <NEmpty v-else description="未获取到额度数据" />
      </NDrawerContent>
    </NDrawer>

    <!-- 签到状态抽屉（只读，无副作用） -->
    <NDrawer v-model:show="checkinOpen" :width="420" placement="right">
      <NDrawerContent :title="`签到状态 · ${checkinTarget?.name ?? ''}`" closable>
        <div v-if="checkinLoading" class="sub">查询中…</div>
        <template v-else-if="checkinStatus">
          <NTag
            :type="checkinStatus.active ? 'success' : 'default'"
            size="small"
            :bordered="false"
            style="margin-bottom: 12px"
          >
            {{ checkinStatus.active ? '活动进行中' : '活动未开放' }}
            <template v-if="checkinStatus.season">
              · 第 {{ checkinStatus.season }} 期 {{ checkinStatus.activityName ?? '' }}
            </template>
          </NTag>

          <ul class="kv">
            <li>
              <span>今日状态</span>
              <b>{{ checkinStatus.todayCheckedIn ? `已领取 +${num(checkinStatus.todayCredit)}` : '未领取' }}</b>
            </li>
            <li><span>每日额度</span><b>{{ num(checkinStatus.dailyCredit) }} credits</b></li>
            <li><span>连续签到</span><b>{{ checkinStatus.streakDays }} 天</b></li>
            <li><span>本期累计</span><b>{{ num(checkinStatus.totalCredits) }} credits</b></li>
            <li>
              <span>本期档期</span>
              <b>{{ checkinStatus.startTime || '—' }} ~ {{ checkinStatus.endTime || '—' }}</b>
            </li>
            <li v-if="checkinDaysLeft !== null">
              <span>剩余</span>
              <b>{{ checkinDaysLeft }} 天</b>
            </li>
            <li v-if="checkinStatus.themeName"><span>活动位</span><b>{{ checkinStatus.themeName }}</b></li>
          </ul>

          <NCard v-if="!checkinStatus.canClaim" size="small" style="margin-top: 12px">
            <div class="sub">
              {{ checkinStatus.claimBlockedReason || '该凭证无权执行领取' }}。
              如需领取，请改用 CLI OAuth 形态的凭证。
            </div>
          </NCard>

          <NCard
            v-if="checkinStatus.actionButton?.show && checkinStatus.actionButton.action"
            size="small"
            style="margin-top: 12px"
          >
            <div class="sub" style="margin-bottom: 8px">上游活动入口</div>
            <NButton
              tag="a"
              :href="checkinStatus.actionButton.action"
              target="_blank"
              rel="noreferrer"
              size="small"
              secondary
            >
              {{ checkinStatus.actionButton.text || '前往活动页' }}
            </NButton>
          </NCard>
        </template>
        <NEmpty v-else description="未获取到签到状态" />
      </NDrawerContent>
    </NDrawer>
  </div>
</template>

<style scoped>
.summary {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-soft);
  background: var(--surface);
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease);
}

.chip:hover {
  border-color: var(--border);
  color: var(--text);
}

.chip.active {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}

.chip-value {
  font-weight: 600;
}

/* 面板头里的次要分隔：把「筛选/批量」与「签到开关」在视觉上分开 */
.divider {
  width: 1px;
  height: 18px;
  background: var(--border-soft);
}

.checkin-toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.checkin-label {
  font-size: 12.5px;
  color: var(--text-2);
}

.help-ico {
  color: var(--text-3);
  cursor: help;
}

.bad {
  color: var(--danger);
}

.quota {
  margin-bottom: 16px;
}

.quota-nums {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.kv {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.kv li {
  display: flex;
  justify-content: space-between;
  gap: 14px;
  font-size: 13px;
}

.kv span {
  color: var(--text-3);
}

.kv b {
  font-weight: 550;
  text-align: right;
  word-break: break-all;
}

:deep(.mono) {
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
</style>
