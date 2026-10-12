<script setup lang="ts">
/**
 * 控制台外壳：顶栏（品牌 / 文字导航 / 状态 / 账号）+ 视图容器。
 *
 * ── 极简口径下与上一版的差别 ────────────────────────────────────────
 *   · 去掉侧栏：导航收敛成顶栏一排纯文字链接，内容区获得全宽。
 *     侧栏在只有 5 个平级视图时是纯开销 —— 它占 224px 宽度，
 *     换来的却是「点击前就知道有几项」这点边际收益。
 *   · 选中态用「颜色 + 2px 下划线」，不用胶囊背景块。
 *   · 状态从彩色胶囊改为「圆点 + 文字」，只表达服务是否可用。
 *   · 去掉主题切换器（本项目只有浅色）、去掉自动刷新开关的显式 UI
 *     （保留每 10 秒自动刷新，但不再占用顶栏空间）。
 *
 * 顶栏承担的是「全局」信息，视图自身的标题与操作留在各视图的 PageHeader 里，
 * 两边不重复。响应式：窄屏隐藏导航文字（见 styles.css / 本文件 media query）。
 */
import { computed, h, onMounted, onUnmounted, ref } from 'vue';
import {
  NButton,
  NConfigProvider,
  NDialogProvider,
  NDropdown,
  NMessageProvider,
  NNotificationProvider,
  type MenuOption,
} from 'naive-ui';
import AppIcon from './components/AppIcon.vue';
import CommandPalette from './components/CommandPalette.vue';
import { refreshNow, startAutoRefresh } from './autoRefresh';
import { ROUTES, navigate, route, startRouter } from './router';
import { refreshAll, store } from './store';
import { themeOverrides } from './theme';
import OverviewView from './views/OverviewView.vue';
import CredentialsView from './views/CredentialsView.vue';
import KeysView from './views/KeysView.vue';
import PlaygroundView from './views/PlaygroundView.vue';
import LogsView from './views/LogsView.vue';

const VIEWS = {
  overview: OverviewView,
  credentials: CredentialsView,
  keys: KeysView,
  playground: PlaygroundView,
  logs: LogsView,
};

const activeView = computed(() => VIEWS[route.value]);

// ── 全局状态 ─────────────────────────────────────────────────────────────
/**
 * 服务健康度由凭证池推导，不额外发请求：
 * 凭证池是网关能否向上游出网的单点，它正常即服务可用。
 *
 * 首屏数据未到时 state 为 null。此时必须与「确实没有凭证」区分开，
 * 否则会对一个正常运行的网关显示「未配置凭证」——状态栏里这是错误情报。
 */
const health = computed(() => {
  const counts = store.state?.counts;
  if (!counts) return { tone: '', text: store.loading ? '加载中…' : '状态未知' };
  if (counts.credentials === 0) return { tone: '', text: '未配置凭证' };
  if (counts.healthy === counts.credentials) return { tone: 'ok', text: `${counts.healthy}/${counts.credentials} 健康` };
  if (counts.healthy > 0) return { tone: 'warn', text: `${counts.healthy}/${counts.credentials} 可用` };
  return { tone: 'bad', text: '无可用凭证' };
});

// ── 导航 ─────────────────────────────────────────────────────────────────
const paletteOpen = ref(false);

const accountOptions: MenuOption[] = [
  { label: '查看模型目录', key: 'models' },
  { label: '查看公开首页', key: 'landing' },
  { type: 'divider', key: 'd1' },
  { label: '退出登录', key: 'logout' },
];

async function logout(): Promise<void> {
  try {
    await fetch('/admin/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    // 网络异常也回登录页,由服务端鉴权决定结果
  }
  window.location.href = '/admin';
}

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
  await refreshAll();
});

onUnmounted(() => {
  stopRouter?.();
  stopAutoRefresh?.();
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <NConfigProvider :theme-overrides="themeOverrides">
    <NMessageProvider :max="3" placement="bottom-right">
      <NDialogProvider>
        <NNotificationProvider :max="3">
          <!-- 顶栏：背景通栏 + 内容按 .page-shell 宽度对齐。
               两者共用同一个宽度令牌，避免左边缘错位。 -->
          <header class="topbar">
            <div class="page-shell topbar-inner">
              <a class="brand" href="/" target="_blank" rel="noopener" title="打开公开首页">
                <i aria-hidden="true"><AppIcon name="shield" :size="12" /></i>
                <b>CodeBuddy Gateway</b>
              </a>

              <nav class="nav" aria-label="主导航">
                <a
                  v-for="item in ROUTES"
                  :key="item.name"
                  href="#"
                  :class="{ on: route === item.name }"
                  :aria-current="route === item.name ? 'page' : undefined"
                  @click.prevent="navigate(item.name)"
                >
                  {{ item.label }}
                </a>
              </nav>

              <div class="topbar-right">
                <button class="palette-btn" @click="paletteOpen = true" title="搜索或跳转">
                  <AppIcon name="search" :size="13" />
                  <kbd>Ctrl K</kbd>
                </button>

                <span class="st" :class="health.tone"><i />{{ health.text }}</span>

                <NButton quaternary size="small" @click="refreshNow" title="立即刷新">
                  <template #icon><AppIcon name="refresh" :size="14" /></template>
                </NButton>

                <NDropdown :options="accountOptions" @select="onAccount">
                  <NButton quaternary size="small" title="账号与入口">
                    <template #icon><AppIcon name="more" :size="14" /></template>
                  </NButton>
                </NDropdown>
              </div>
            </div>
          </header>

          <main class="content">
            <component :is="activeView" />
          </main>

          <CommandPalette v-model:show="paletteOpen" />
        </NNotificationProvider>
      </NDialogProvider>
    </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
/* ── 顶栏 ──
   外层只管通栏背景与吸顶，内层（.page-shell）负责内容对齐 ——
   「背景通栏 + 内容对齐」分开，才不会互相牵制。 */
.topbar {
  position: sticky;
  top: 0;
  z-index: 20;
  background: color-mix(in srgb, var(--bg) 86%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--line);
}

.topbar-inner {
  display: flex;
  align-items: center;
  gap: 28px;
  height: 52px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: none;
  text-decoration: none;
  color: inherit;
}

.brand i {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  background: var(--text);
  color: #fff;
}

.brand b {
  font-size: 13px;
  font-weight: 640;
  letter-spacing: -0.01em;
  white-space: nowrap;
}

/* 导航：纯文字链接。选中态用颜色 + 一条 2px 下划线，不用胶囊背景。 */
.nav {
  display: flex;
  align-items: center;
  gap: 22px;
  flex: 1;
  min-width: 0;
}

.nav a {
  position: relative;
  font-size: 13px;
  color: var(--text-3);
  white-space: nowrap;
  padding: 15px 0;
  text-decoration: none;
  transition: color var(--dur) var(--ease);
}

.nav a:hover {
  color: var(--text);
}

.nav a.on {
  color: var(--text);
  font-weight: 600;
}

.nav a.on::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--text);
  border-radius: 1px;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: none;
}

/* 命令面板入口：极简的检索按钮，不带边框负担 */
.palette-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-3);
  font: inherit;
  transition: border-color var(--dur) var(--ease), color var(--dur) var(--ease);
}

.palette-btn:hover {
  border-color: var(--line-strong);
  color: var(--text-2);
}

.palette-btn kbd {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--text-3);
}

.content {
  padding-top: 36px;
  padding-bottom: 88px;
}

@media (max-width: 900px) {
  .nav {
    gap: 16px;
  }

  .palette-btn {
    display: none;
  }
}

@media (max-width: 640px) {
  .topbar-inner {
    gap: 14px;
  }

  .brand b {
    display: none;
  }

  .nav {
    gap: 14px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .nav::-webkit-scrollbar {
    display: none;
  }

  .content {
    padding-top: 24px;
    padding-bottom: 56px;
  }
}
</style>
