/**
 * 每日自动签到(Buddy 加油站,进程内定时器触发)。
 *
 * 逻辑:读取全局设置 autoCheckin → 对每个启用的上游凭证:
 *   1. 先查签到活动状态(只读)——活动未开始/已结束则跳过本轮,不产生噪音失败
 *   2. 该凭证无领取权限(如 ck_ 前缀控制台 Key)则跳过并计入 blocked
 *   3. 活动进行中且有权限 → 执行 daily-checkin;上游保证每日一次,重复调用为幂等
 *
 * 期次滚动:活动按期开放(如第 8 期「开学季」2026-09-01~09-15),期号由状态接口下发,
 * 本模块不硬编码任何期次或日期——新一期开放后无需改代码即可自动接续。
 */

import { getTokenStore } from './store';
import { fetchCheckinStatus, fetchDailyCheckin } from './upstream-billing';
import { pushLog } from './logs';
import type { Credential } from './types';

export interface AutoCheckinReport {
  triggered: boolean;
  autoCheckin: boolean;
  total: number;
  ok: number;
  skipped: number;
  /** 有效活动未开放而跳过 */
  inactive: number;
  /** 凭证无领取权限而跳过 */
  blocked: number;
  /** 本期期号(取首个可用凭证的状态) */
  season?: number;
  /** 本期活动名 */
  activityName?: string;
  /** 本期结束时间(用于观测期次滚动) */
  endTime?: string;
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
    inactive: 0,
    blocked: 0,
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
      // ── 先查状态:活动未开放则不产生任何领取调用 ──
      const status = await fetchCheckinStatus(credential, env as never);
      report.season ??= status.season;
      report.activityName ??= status.activityName;
      report.endTime ??= status.endTime;

      if (!status.active) {
        report.inactive += 1;
        continue;
      }
      if (!status.canClaim) {
        report.blocked += 1;
        pushLog('warn', 'auto_checkin', `${credential.name} 无领取权限，已跳过`, {
          credential: credential.name,
          reason: status.claimBlockedReason,
          season: status.season,
        });
        continue;
      }

      await fetchDailyCheckin(credential, env as never);
      report.ok += 1;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // "今日已签到"等上游业务拒绝不视为失败
      if (/签到失败|签到被拒绝/.test(message)) {
        report.failures.push(`${credential.name}: ${message}`);
      } else {
        report.skipped += 1;
      }
    }
  }

  pushLog(
    'info',
    'auto_checkin',
    `自动签到完成：成功 ${report.ok}/${report.total}，未开放 ${report.inactive}，无权限 ${report.blocked}，跳过 ${report.skipped}` +
      (report.season ? `（第 ${report.season} 期 ${report.activityName ?? ''}，至 ${report.endTime ?? '—'}）` : ''),
    {
      total: report.total,
      ok: report.ok,
      inactive: report.inactive,
      blocked: report.blocked,
      skipped: report.skipped,
      season: report.season,
      activityName: report.activityName,
      endTime: report.endTime,
      failures: report.failures.slice(0, 5),
    },
  );

  return report;
}
