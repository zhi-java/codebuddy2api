/**
 * 极简 hash 路由。
 *
 * 控制台只有 6 个平级视图，引入 vue-router 不划算；用 location.hash
 * 即可获得可分享深链（如 /admin#/credentials）与浏览器前进后退支持。
 */

import { ref } from 'vue';

export const ROUTES = [
  { name: 'overview', label: '总览', icon: 'overview', group: '观测' },
  { name: 'credentials', label: '上游凭证', icon: 'credentials', group: '资源' },
  { name: 'keys', label: 'API Keys', icon: 'keys', group: '资源' },
  { name: 'playground', label: '试跑', icon: 'playground', group: '调试' },
  { name: 'logs', label: '日志', icon: 'logs', group: '调试' },
  { name: 'settings', label: '设置', icon: 'settings', group: '系统' },
] as const;

export type RouteName = (typeof ROUTES)[number]['name'];

const VALID = new Set<string>(ROUTES.map((route) => route.name));

export const route = ref<RouteName>(readRoute());

function readRoute(): RouteName {
  const raw = window.location.hash.replace(/^#\/?/, '').trim();
  return (VALID.has(raw) ? raw : 'overview') as RouteName;
}

export function navigate(name: string): void {
  const target = (VALID.has(name) ? name : 'overview') as RouteName;
  if (readRoute() === target) {
    route.value = target;
    return;
  }
  window.location.hash = `#/${target}`;
}

/** 启动路由监听(返回取消函数) */
export function startRouter(): () => void {
  const onChange = () => {
    route.value = readRoute();
  };
  window.addEventListener('hashchange', onChange);
  // 首次进入补一个默认 hash，保证刷新/复制链接行为一致
  if (!window.location.hash) window.location.replace('#/overview');
  return () => window.removeEventListener('hashchange', onChange);
}
