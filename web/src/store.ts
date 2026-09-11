/**
 * 控制台共享状态。
 *
 * 凭证、Key、运行配置被多个视图复用（总览统计、Key 绑定列表、试跑凭证下拉、
 * 设置页只读配置），集中在一处刷新，避免各视图重复请求与状态分叉。
 */

import { reactive } from 'vue';
import { api, type DataResponse } from './api';
import type { CredentialSummary, GatewayConfig, GatewaySettings, GatewayState, KeySummary } from './types';

export const store = reactive({
  credentials: [] as CredentialSummary[],
  keys: [] as KeySummary[],
  state: null as GatewayState | null,
  settings: null as GatewaySettings | null,
  config: null as GatewayConfig | null,
  loading: false,
  /** 最近一次基础数据刷新完成的时间戳 */
  refreshedAt: 0,
});

/** 拉取凭证 + Key + 网关状态(管理台各视图共用的基础数据)。 */
export async function refreshAll(): Promise<void> {
  store.loading = true;
  try {
    const [creds, keys, state] = await Promise.all([
      api<DataResponse<CredentialSummary[]>>('/admin/api/credentials'),
      api<DataResponse<KeySummary[]>>('/admin/api/keys'),
      api<GatewayState>('/admin/api/state'),
    ]);
    store.credentials = creds.data ?? [];
    store.keys = keys.data ?? [];
    store.state = state;
    store.refreshedAt = Date.now();
  } finally {
    store.loading = false;
  }
}

/** 只刷新凭证(凭证增删改后调用)。 */
export async function refreshCredentials(): Promise<void> {
  const creds = await api<DataResponse<CredentialSummary[]>>('/admin/api/credentials');
  store.credentials = creds.data ?? [];
  store.state = await api<GatewayState>('/admin/api/state');
  store.refreshedAt = Date.now();
}

/** 只刷新 Key(Key 增删改后调用)。 */
export async function refreshKeys(): Promise<void> {
  const keys = await api<DataResponse<KeySummary[]>>('/admin/api/keys');
  store.keys = keys.data ?? [];
  store.state = await api<GatewayState>('/admin/api/state');
  store.refreshedAt = Date.now();
}

/** 读取网关设置(带缓存)。 */
export async function loadSettings(force = false): Promise<GatewaySettings> {
  if (!store.settings || force) {
    const res = await api<DataResponse<GatewaySettings>>('/admin/api/settings');
    store.settings = res.data ?? { autoCheckin: false };
  }
  return store.settings;
}

/** 保存网关设置并同步本地缓存。 */
export async function saveSettings(patch: Partial<GatewaySettings>): Promise<GatewaySettings> {
  const res = await api<DataResponse<GatewaySettings>>('/admin/api/settings', { method: 'PUT', body: patch });
  store.settings = res.data ?? { autoCheckin: false };
  return store.settings;
}

/** 读取运行配置(只读,设置页展示)。 */
export async function loadConfig(force = false): Promise<GatewayConfig> {
  if (!store.config || force) {
    const res = await api<DataResponse<GatewayConfig>>('/admin/api/config');
    store.config = res.data;
  }
  return store.config as GatewayConfig;
}

export function credentialById(id: string): CredentialSummary | undefined {
  return store.credentials.find((item) => item.id === id);
}

export function credentialName(id: string): string {
  return credentialById(id)?.name ?? id;
}
