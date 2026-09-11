/**
 * 自动刷新调度。
 *
 * 总览/凭证/日志等视图共用同一个心跳：所有视图监听 `tick` 重新取数，
 * 由顶栏统一控制开关与节奏，避免每个视图各自 setInterval。
 * 页面不可见时自动跳过（后台标签页不必继续打网关）。
 */

import { ref } from 'vue';

const STORAGE_KEY = 'cb.autoRefresh';
const DEFAULT_INTERVAL_MS = 10_000;

export const autoRefresh = ref(localStorage.getItem(STORAGE_KEY) !== 'off');
export const tick = ref(0);
export const lastTickAt = ref(Date.now());
export const intervalMs = ref(DEFAULT_INTERVAL_MS);

let timer: number | undefined;

function fire(): void {
  tick.value += 1;
  lastTickAt.value = Date.now();
}

export function startAutoRefresh(): () => void {
  if (timer !== undefined) return () => undefined;
  timer = window.setInterval(() => {
    if (!autoRefresh.value) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    fire();
  }, intervalMs.value);
  return () => {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
  };
}

export function setAutoRefresh(enabled: boolean): void {
  autoRefresh.value = enabled;
  localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  if (enabled) fire();
}

/** 手动触发一次（顶栏「刷新」按钮）。 */
export function refreshNow(): void {
  fire();
}
