/**
 * 极简 hash 路由。
 *
 * 控制台只有 5 个平级视图，引入 vue-router 不划算；用 location.hash
 * 即可获得可分享深链（如 /admin#/credentials）与浏览器前进后退支持。
 *
 * 导航只保留「有事要做」才点进去的入口。原先的「设置」页已移除：
 * 其可写项（自动签到开关、退出登录）在凭证页与顶栏已有，
 * 只读项（运行参数、上游地址）来自环境变量，权威在 docker-compose.yml。
 */

import { ref } from 'vue';

/**
 * 视图按「日常在看」与「一次性配好」切分，各 3 / 2 项。
 * 组标题只在超过 4 项时才值得分组，故这里不再分组 —— 5 项平铺即可。
 */
export const ROUTES = [
  { name: 'overview', label: '总览', icon: 'overview' },
  { name: 'credentials', label: '凭证', icon: 'credentials' },
  { name: 'keys', label: 'Keys', icon: 'keys' },
  { name: 'playground', label: '对话', icon: 'playground' },
  { name: 'logs', label: '日志', icon: 'logs' },
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
