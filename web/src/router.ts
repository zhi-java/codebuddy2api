/**
 * 极简 hash 路由。
 *
 * 控制台只有 6 个平级视图，引入 vue-router 不划算；用 location.hash
 * 即可获得可分享深链（如 /admin#/credentials）与浏览器前进后退支持。
 */

import { ref } from 'vue';

/**
 * 导航分为两组，各 3 项：按「日常在看」与「一次性配好」切分。
 * 原先的 4 组每组只有 1–2 项，侧栏被组标题切得零碎，反而看不清结构。
 */
export const ROUTES = [
  { name: 'overview', label: '总览', icon: 'overview', group: '运行' },
  { name: 'playground', label: '试跑', icon: 'playground', group: '运行' },
  { name: 'logs', label: '日志', icon: 'logs', group: '运行' },
  { name: 'credentials', label: '上游凭证', icon: 'credentials', group: '配置' },
  { name: 'keys', label: 'API Keys', icon: 'keys', group: '配置' },
  { name: 'settings', label: '设置', icon: 'settings', group: '配置' },
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
