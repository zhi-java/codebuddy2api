/**
 * 每日自动签到(进程内定时器触发)。
 *
 * 逻辑:读取全局设置 autoCheckin → 对每个启用的上游凭证执行一次 daily-checkin。
 * 上游会拒绝当日重复签到(code != 0),错误被吞掉并只做计数统计,不影响其他凭证。
 */

import { getTokenStore } from './store';
import { fetchDailyCheckin } from './upstream-billing';
import { pushLog } from './logs';
import type { Credential } from './types';

export interface AutoCheckinReport {
  triggered: boolean;
  autoCheckin: boolean;
  total: number;
  ok: number;
  skipped: number;
  failures: string[];
  at: number;
}

interface ScheduledEnv {
  CREDENTIALS_KV?: unknown;
  CREDENTIALS_ENC_SECRET?: string;
}

/**
 * 执行一轮自动签到。幂等安全:无论何时被调用(手动或 cron),上游保证每日一次。
 */
export async function performAutoCheckins(env: ScheduledEnv): Promise<AutoCheckinReport> {
  const store = getTokenStore(env as never);
  const settings = await store.getSettings();
  const report: AutoCheckinReport = {
    triggered: true,
    autoCheckin: settings.autoCheckin,
    total: 0,
    ok: 0,
    skipped: 0,
    failures: [],
    at: Date.now(),
  };

  if (!settings.autoCheckin) {
    pushLog('info', 'auto_checkin', '自动签到未开启，跳过本轮到点执行');
    return report;
  }

  const credentials = await store.listCredentials();
  const candidates = credentials.filter(
    (c): c is Credential => c.enabled && (c.kind === 'ck_apikey' || c.kind === 'cli_oauth'),
  );
  report.total = candidates.length;

  // 顺序执行,避免瞬时并发打满上游
  for (const credential of candidates) {
    try {
      await fetchDailyCheckin(credential, env as never);
      report.ok += 1;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // "今日已签到"等上游业务拒绝不视为失败
      if (/签到失败/.test(message)) {
        report.failures.push(`${credential.name}: ${message}`);
      } else {
        report.skipped += 1;
      }
    }
  }

  pushLog('info', 'auto_checkin', `自动签到完成：成功 ${report.ok}/${report.total}，跳过 ${report.skipped}`, {
    total: report.total,
    ok: report.ok,
    skipped: report.skipped,
    failures: report.failures.slice(0, 5),
  });

  return report;
}
