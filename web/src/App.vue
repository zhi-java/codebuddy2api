<script setup lang="ts">
/**
 * 控制台外壳：侧栏导航 + 顶栏（环境/自动刷新/主题/账号）+ 视图容器。
 *
 * 顶栏承担三件事，都是运维台的日常必需信息：
 *   1. 当前视图标题与说明（视图自带页头，这里只放全局状态）；
 *   2. 数据新鲜度（自动刷新开关 + 距上次刷新时间）；
 *   3. 主题与账号入口。
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
  NTag,
  NTooltip,
  darkTheme,
  dateZhCN,
  zhCN,
  type MenuOption,
} from 'naive-ui';
import AppIcon from './components/AppIcon.vue';
import CommandPalette from './components/CommandPalette.vue';
import { autoRefresh, refreshNow, setAutoRefresh, startAutoRefresh } from './autoRefresh';
import { ROUTES, navigate, route, startRouter } from './router';
import { refreshAll, store } from './store';
import { darkOverrides, lightOverrides } from './theme';
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

// ── 主题 ─────────────────────────────────────────────────────────────────
type ThemeMode = 'system' | 'dark' | 'light';
const themeMode = ref<ThemeMode>((localStorage.getItem('cb.theme') as ThemeMode) ?? 'system');
const systemPrefersLight = window.matchMedia('(prefers-color-scheme: light)');

const isDark = computed(() => {
  if (themeMode.value === 'dark') return true;
  if (themeMode.value === 'light') return false;
  return !systemPrefersLight.matches;
});

const theme = computed(() => (isDark.value ? darkTheme : null));
const overrides = computed(() => (isDark.value ? darkOverrides : lightOverrides));

function setTheme(mode: ThemeMode): void {
  themeMode.value = mode;
  localStorage.setItem('cb.theme', mode);
}

const themeOptions: MenuOption[] = [
  { label: '跟随系统', key: 'system' },
  { label: '深色', key: 'dark' },
  { label: '浅色', key: 'light' },
];

// ── 导航 ─────────────────────────────────────────────────────────────────
const menuOptions = computed<MenuOption[]>(() => {
  const groups = new Map<string, MenuOption[]>();
  for (const item of ROUTES) {
    const list = groups.get(item.group) ?? [];
    list.push({
      label: item.label,
      key: item.name,
      icon: () => h(AppIcon, { name: item.icon, size: 16 }),
    });
    groups.set(item.group, list);
  }
  return [...groups.entries()].map(([group, children]) => ({ type: 'group', label: group, key: group, children }));
});

const collapsed = ref(false);
const paletteOpen = ref(false);

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
  { label: '退出登录', key: 'logout' },
];

function onAccount(key: string): void {
  if (key === 'logout') void logout();
  else if (key === 'models') window.open('/v1/models', '_blank', 'noopener');
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
  hintTimer = window.setInterval(updateRefreshHint, 1000);
  await refreshAll();
  updateRefreshHint();
});

onUnmounted(() => {
  stopRouter?.();
  stopAutoRefresh?.();
  window.removeEventListener('keydown', onKeydown);
  if (hintTimer) window.clearInterval(hintTimer);
});

</script>

<template>
  <NConfigProvider :theme="theme" :theme-overrides="overrides" :locale="zhCN" :date-locale="dateZhCN">
    <NMessageProvider :max="3" placement="bottom-right">
      <NDialogProvider>
        <NNotificationProvider :max="3">
          <NLayout has-sider style="height: 100vh">
            <NLayoutSider
              bordered
              collapse-mode="width"
              :collapsed-width="58"
              :width="222"
              :collapsed="collapsed"
              show-trigger
              @collapse="collapsed = true"
              @expand="collapsed = false"
            >
              <div class="brand">
                <div class="brand-logo" aria-hidden="true">
                  <AppIcon name="shield" :size="16" />
                </div>
                <div v-if="!collapsed" class="brand-text">
                  <div class="brand-name">CodeBuddy Gateway</div>
                  <div class="brand-sub">Production console</div>
                </div>
              </div>

              <NMenu
                :value="route"
                :collapsed="collapsed"
                :collapsed-width="58"
                :collapsed-icon-size="18"
                :options="menuOptions"
                :indent="16"
                @update:value="(value: string) => navigate(value)"
              />

              <div class="sider-foot">
                <div v-if="!collapsed" class="env" title="凭证存储后端">
                  <span class="storage">
                    <i class="dot" :class="{ mem: store.state?.storage !== 'persistent' }" />
                    {{ store.state?.storage === 'persistent' ? 'SQLite 持久化' : '内存存储' }}
                  </span>
                </div>
                <NButton quaternary block size="small" @click="logout">
                  <template #icon><AppIcon name="logout" :size="15" /></template>
                  <span v-if="!collapsed">退出登录</span>
                </NButton>
              </div>
            </NLayoutSider>

            <NLayoutContent content-style="height: 100%; overflow: auto">
              <div class="topbar">
                <button class="palette-btn" @click="paletteOpen = true">
                  <AppIcon name="search" :size="14" />
                  <span>搜索或跳转</span>
                  <kbd>Ctrl K</kbd>
                </button>

                <div class="topbar-right">
                  <NTooltip>
                    <template #trigger>
                      <div class="refresh">
                        <NSwitch
                          size="small"
                          :value="autoRefresh"
                          @update:value="setAutoRefresh"
                        />
                        <span class="hint">{{ refreshHint }}</span>
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

                  <NDropdown :options="themeOptions" :value="themeMode" @select="setTheme">
                    <NButton quaternary size="small">
                      <template #icon><AppIcon :name="isDark ? 'moon' : 'sun'" :size="15" /></template>
                    </NButton>
                  </NDropdown>

                  <NDropdown :options="accountOptions" @select="onAccount">
                    <NButton quaternary size="small">
                      <template #icon><AppIcon name="server" :size="15" /></template>
                    </NButton>
                  </NDropdown>
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
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 16px 14px;
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

.brand-name {
  font-size: 13px;
  font-weight: 650;
  letter-spacing: -0.01em;
}

.brand-sub {
  font-size: 10.5px;
  color: var(--text-3);
  letter-spacing: 0.08em;
  font-variant: small-caps;
}

.sider-foot {
  position: absolute;
  inset: auto 0 0 0;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border-soft);
}

.env {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 4px;
}

.storage {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.dot.mem {
  background: var(--warn);
}

.topbar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 20px;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-soft);
}

.palette-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  min-width: 220px;
  border-radius: 8px;
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

.topbar-right {
  display: flex;
  align-items: center;
  gap: 6px;
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
  font-variant-numeric: tabular-nums;
  min-width: 76px;
}

.content {
  padding: 20px 22px 48px;
}

@media (max-width: 720px) {
  .content {
    padding: 16px 14px 40px;
  }

  .palette-btn {
    min-width: 0;
  }

  .palette-btn span {
    display: none;
  }
}
</style>
