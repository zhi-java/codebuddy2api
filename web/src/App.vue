<script setup lang="ts">
/**
 * 控制台外壳：侧栏导航 + 顶栏（全局状态 / 检索 / 数据新鲜度 / 主题 / 账号）+ 视图容器。
 *
 * 顶栏承担的是「全局」信息，视图自身的标题与操作留在各视图的 PageHeader 里，
 * 两边不重复：左侧只放一处服务状态与存储后端，右侧是随时可用的全局控制。
 *
 * 响应式：窄屏自动收起侧栏（只留图标），顶栏隐藏检索文案与时间提示，
 * 保证 375px 宽度下不出现横向滚动。
 */
import { computed, h, onMounted, onUnmounted, ref } from 'vue';
import {
  NButton,
  NConfigProvider,
  NDialogProvider,
  NDropdown,
  NLayout,
  NLayoutContent,
  NLayoutSider,
  NMenu,
  NMessageProvider,
  NNotificationProvider,
  NSwitch,
  NTooltip,
  dateZhCN,
  zhCN,
  type MenuOption,
} from 'naive-ui';
import AppIcon from './components/AppIcon.vue';
import CommandPalette from './components/CommandPalette.vue';
import { autoRefresh, refreshNow, setAutoRefresh, startAutoRefresh } from './autoRefresh';
import { ROUTES, navigate, route, startRouter } from './router';
import { refreshAll, store } from './store';
import { themeOverrides } from './theme';
import OverviewView from './views/OverviewView.vue';
import CredentialsView from './views/CredentialsView.vue';
import KeysView from './views/KeysView.vue';
import PlaygroundView from './views/PlaygroundView.vue';
import LogsView from './views/LogsView.vue';
import SettingsView from './views/SettingsView.vue';

const VIEWS = {
  overview: OverviewView,
  credentials: CredentialsView,
  keys: KeysView,
  playground: PlaygroundView,
  logs: LogsView,
  settings: SettingsView,
};

const activeView = computed(() => VIEWS[route.value]);

// 主题：仅浅色，无切换机制（令牌见 tokens.css，组件覆写见 theme.ts）

// ── 全局状态 ─────────────────────────────────────────────────────────────
/**
 * 服务健康度由凭证池推导，不额外发请求：
 * 凭证池是网关能否向上游出网的单点，它正常即服务可用。
 */
const health = computed(() => {
  const counts = store.state?.counts;
  // 首屏数据未到时 state 为 null。此时必须与「确实没有凭证」区分开，
  // 否则会对一个正常运行的网关显示「未配置凭证」——状态栏里这是错误情报。
  if (!counts) return { tone: 'idle', text: store.loading ? '加载中…' : '状态未知' };
  if (counts.credentials === 0) return { tone: 'idle', text: '未配置凭证' };
  if (counts.healthy === counts.credentials) return { tone: 'ok', text: '运行正常' };
  if (counts.healthy > 0) return { tone: 'warn', text: `凭证降级 ${counts.healthy}/${counts.credentials}` };
  return { tone: 'bad', text: '无可用凭证' };
});

const storageText = computed(() => {
  // 同上：未拿到 state 时不能断言「内存存储」，那会误报数据不持久
  if (!store.state) return '存储未知';
  return store.state.storage === 'persistent' ? 'SQLite 持久化' : '内存存储（重启丢失）';
});

// ── 导航 ─────────────────────────────────────────────────────────────────
const collapsed = ref(false);
const paletteOpen = ref(false);

/** 导航徽标：把「有多少东西要管」直接标在入口上，省一次点进去才知道 */
const navBadges = computed<Record<string, number>>(() => {
  const badges: Record<string, number> = {};
  const counts = store.state?.counts;
  if (counts) {
    badges.credentials = counts.credentials;
    badges.keys = counts.keys;
  }
  return badges;
});

const menuOptions = computed<MenuOption[]>(() => {
  const groups = new Map<string, MenuOption[]>();
  for (const item of ROUTES) {
    const badge = navBadges.value[item.name];
    const children = groups.get(item.group) ?? [];
    children.push({
      label: item.label,
      key: item.name,
      icon: () => h(AppIcon, { name: item.icon, size: 16 }),
      // 收起态下放徽标会挤成一团，只在展开时渲染
      ...(badge && !collapsed.value
        ? { extra: () => h('span', { class: 'nav-badge tnum' }, String(badge)) }
        : {}),
    });
    groups.set(item.group, children);
  }
  return [...groups.entries()].map(([group, children]) => ({ type: 'group', label: group, key: group, children }));
});

/** 窄屏自动收起侧栏；用户手动展开后不再干预 */
let autoCollapsed = false;
function syncCollapsed(): void {
  const narrow = window.innerWidth < 960;
  if (narrow) {
    if (!collapsed.value) {
      collapsed.value = true;
      autoCollapsed = true;
    }
  } else if (autoCollapsed) {
    collapsed.value = false;
    autoCollapsed = false;
  }
}

function onSelect(key: string): void {
  navigate(key);
  // 窄屏下选完即收起，避免遮住内容
  if (window.innerWidth < 960) collapsed.value = true;
}

// 顶栏的「距上次刷新」文案：只在最近 1 分钟内做秒级提示,更早交给自动刷新
const refreshHint = ref('');
let hintTimer: number | undefined;

function updateRefreshHint(): void {
  if (!store.refreshedAt) {
    refreshHint.value = '加载中…';
    return;
  }
  const seconds = Math.round((Date.now() - store.refreshedAt) / 1000);
  refreshHint.value = seconds < 5 ? '刚刚更新' : `${seconds} 秒前更新`;
}

async function logout(): Promise<void> {
  try {
    await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // 网络异常也回登录页,由服务端鉴权决定结果
  }
  window.location.href = '/admin';
}

const accountOptions: MenuOption[] = [
  { label: '查看模型目录', key: 'models' },
  { label: '查看公开首页', key: 'landing' },
  { type: 'divider', key: 'd1' },
  { label: '退出登录', key: 'logout' },
];

function onAccount(key: string): void {
  if (key === 'logout') void logout();
  else if (key === 'models') window.open('/v1/models', '_blank', 'noopener');
  else if (key === 'landing') window.open('/', '_blank', 'noopener');
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    paletteOpen.value = !paletteOpen.value;
  }
}

let stopRouter: (() => void) | undefined;
let stopAutoRefresh: (() => void) | undefined;

onMounted(async () => {
  stopRouter = startRouter();
  stopAutoRefresh = startAutoRefresh();
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', syncCollapsed);
  syncCollapsed();
  hintTimer = window.setInterval(updateRefreshHint, 1000);
  await refreshAll();
  updateRefreshHint();
});

onUnmounted(() => {
  stopRouter?.();
  stopAutoRefresh?.();
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', syncCollapsed);
  if (hintTimer) window.clearInterval(hintTimer);
});
</script>

<template>
  <NConfigProvider :theme-overrides="themeOverrides" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider :max="3" placement="bottom-right">
      <NDialogProvider>
        <NNotificationProvider :max="3">
          <NLayout has-sider style="height: 100vh">
            <NLayoutSider
              bordered
              collapse-mode="width"
              :collapsed-width="58"
              :width="224"
              :collapsed="collapsed"
              show-trigger
              @collapse="collapsed = true"
              @expand="collapsed = false"
            >
              <div class="sider">
                <a class="brand" href="/" target="_blank" rel="noopener" title="打开公开首页">
                  <span class="brand-logo" aria-hidden="true">
                    <AppIcon name="shield" :size="16" />
                  </span>
                  <span v-if="!collapsed" class="brand-text">
                    <b>CodeBuddy Gateway</b>
                    <i>Production console</i>
                  </span>
                </a>

                <NMenu
                  :value="route"
                  :collapsed="collapsed"
                  :collapsed-width="58"
                  :collapsed-icon-size="18"
                  :options="menuOptions"
                  :indent="16"
                  @update:value="onSelect"
                />

                <div class="sider-foot">
                  <NTooltip :disabled="!collapsed" placement="right">
                    <template #trigger>
                      <div class="storage" :class="{ mem: store.state?.storage !== 'persistent' }">
                        <i class="dot" />
                        <span v-if="!collapsed">{{ store.state?.storage === 'persistent' ? 'SQLite' : '内存' }}</span>
                      </div>
                    </template>
                    {{ storageText }}
                  </NTooltip>
                  <NButton quaternary size="small" block @click="logout">
                    <template #icon><AppIcon name="logout" :size="15" /></template>
                    <span v-if="!collapsed">退出登录</span>
                  </NButton>
                </div>
              </div>
            </NLayoutSider>

            <NLayoutContent
              content-style="height: 100%; overflow: auto; scrollbar-gutter: stable"
            >
              <div class="topbar">
                <!-- 顶栏背景通栏，内容用与 .page 完全相同的宽度规则（同一个
                     .page-shell 类），否则两者各自计算宽度会导致左边缘错位。
                     原先 topbar 用固定 padding、.page 用 max-width 居中，
                     两者宽度不同，内容起点会差出 20px 以上。 -->
                <div class="page-shell topbar-inner">
                <div class="status" :class="health.tone">
                  <i class="status-dot" />
                  <span class="status-text">{{ health.text }}</span>
                  <span v-if="store.state" class="status-sub">{{ storageText }}</span>
                </div>

                <div class="topbar-right">
                  <button class="palette-btn" @click="paletteOpen = true">
                    <AppIcon name="search" :size="14" />
                    <span>搜索或跳转</span>
                    <kbd>Ctrl K</kbd>
                  </button>

                  <NTooltip>
                    <template #trigger>
                      <div class="refresh">
                        <NSwitch size="small" :value="autoRefresh" @update:value="setAutoRefresh" />
                        <span class="hint tnum">{{ refreshHint }}</span>
                      </div>
                    </template>
                    开启后每 10 秒自动刷新，页面切到后台时暂停
                  </NTooltip>

                  <NTooltip>
                    <template #trigger>
                      <NButton quaternary size="small" @click="refreshNow">
                        <template #icon><AppIcon name="refresh" :size="15" /></template>
                      </NButton>
                    </template>
                    立即刷新
                  </NTooltip>

                  <NDropdown :options="accountOptions" @select="onAccount">
                    <NButton quaternary size="small" title="账号与入口">
                      <template #icon><AppIcon name="server" :size="15" /></template>
                    </NButton>
                  </NDropdown>
                </div>
                </div>
              </div>

              <div class="content">
                <component :is="activeView" />
              </div>
            </NLayoutContent>
          </NLayout>

          <CommandPalette v-model:show="paletteOpen" />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
.sider {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 12px;
  text-decoration: none;
  color: inherit;
}

.brand-logo {
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: #052e16;
  background: linear-gradient(180deg, #4ade80, #16a34a);
  box-shadow: 0 0 0 1px rgba(34, 197, 94, 0.35), 0 8px 18px rgba(22, 163, 74, 0.25);
}

.brand-text {
  min-width: 0;
}

.brand-text b {
  display: block;
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

.brand-text i {
  display: block;
  font-size: 10px;
  font-style: normal;
  color: var(--text-3);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

:deep(.nav-badge) {
  font-size: 11px;
  color: var(--text-3);
  background: var(--surface-3);
  border-radius: 999px;
  padding: 1px 7px;
  margin-left: 8px;
  font-weight: 550;
}

.sider-foot {
  margin-top: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  border-top: 1px solid var(--border-soft);
}

.storage {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  font-size: 11.5px;
  color: var(--text-3);
}

.storage .dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--accent);
}

.storage.mem .dot {
  background: var(--warn);
}

/* ── 顶栏 ──
   外层只管通栏背景，内层 .topbar-inner（共用 .page-shell 宽度规则）负责
   内容对齐——「背景通栏 + 内容对齐」这两件事分开，才不会互相牵制。 */
.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  padding: 9px 0;
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border-soft);
}

/* 与 .page 逐字相同的宽度规则。
   不引用全局 .page-shell：styles.css 是全局样式，而这里编译后会带 scoped
   作用域属性，全局类选择器匹配不上（实测 max-width 仍为 none）。
   两边都直接读同一组令牌，改宽度只需改令牌。 */
.topbar-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  padding-left: var(--content-gutter);
  padding-right: var(--content-gutter);
}

/* 全局状态：一处说清服务是否可用 + 数据落在哪里 */
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text-2);
}

.status-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: var(--text-3);
}

.status.ok .status-dot {
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
}

.status.warn .status-dot {
  background: var(--warn);
  box-shadow: 0 0 0 4px var(--warn-soft);
}

.status.bad .status-dot {
  background: var(--danger);
  box-shadow: 0 0 0 4px var(--danger-soft);
}

.status-text {
  font-weight: 550;
  color: var(--text);
  white-space: nowrap;
}

.status-sub {
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-sub::before {
  content: '·';
  margin-right: 8px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}

.palette-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  min-width: 216px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-3);
  font: inherit;
  font-size: 12.5px;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease);
}

.palette-btn:hover {
  border-color: var(--accent);
  color: var(--text-2);
}

.palette-btn kbd {
  margin-left: auto;
  font-size: 10.5px;
  background: var(--surface-3);
  border-radius: 4px;
  padding: 0 5px;
}

.refresh {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
}

.hint {
  font-size: 11.5px;
  color: var(--text-3);
  min-width: 76px;
}

/**
 * 内容区只负责纵向节奏；横向内衬交给 .page（内层容器）。
 *
 * 此前这里是 `padding: 20px 22px 56px`，加上 .page 自身的 20px，
 * 横向共 42px；而顶栏只有 20px —— 两者相差的 22px 正是顶栏与内容
 * 左边缘错位的原因。横向内衬必须只有一个来源，否则任何一次调整
 * 都会让两侧重新错开。
 */
.content {
  padding-top: 20px;
  padding-bottom: 56px;
}

@media (max-width: 960px) {
  .status-sub {
    display: none;
  }

  .palette-btn {
    min-width: 0;
  }

  .palette-btn span,
  .palette-btn kbd {
    display: none;
  }
}

@media (max-width: 640px) {
  /* 窄屏只收窄内衬宽度，仍走同一个令牌，保证顶栏与内容左边缘继续对齐 */
  .topbar {
    padding: 8px var(--content-gutter);
  }

  .hint {
    display: none;
  }

  .content {
    padding: 14px 14px 40px;
  }
}
</style>
