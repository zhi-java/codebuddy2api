/**
 * 每日自动签到(Buddy 加油站,进程内定时器触发)。
 *
 * 逻辑:读取全局设置 autoCheckin → 对每个启用的上游凭证:
 *   1. 先查签到活动状态(只读)——活动未开始/已结束则跳过本轮,不产生噪音失败
 *   2. 该凭证无领取权限(如 ck_ 前缀控制台 Key)则跳过并计入 blocked
 *   3. 今日已签到则跳过领取调用(省一次上游请求),只做只读状态查询
 *   4. 否则执行 daily-checkin;上游保证每日一次,重复调用为幂等
 *
 * 期次滚动:活动按期开放(如第 8 期「开学季」2026-09-01~09-15),期号由状态接口下发,
 * 本模块不硬编码任何期次或日期——新一期开放后无需改代码即可自动接续。
 *
 * 防漏签:签到是「每天一次、断签归零连续天数」的机制,漏一天代价不小。因此主时点
 * 执行后若有凭证仍未签到(网络抖动、上游 5xx、容器恰好在主时点重启等),按递增间隔
 * 补签若干次(pending 计数驱动,见 planNextCheckinRun);补签用尽则等次日主时点。
 */

import { getTokenStore } from './store';
import { fetchCheckinStatus, fetchDailyCheckin } from './upstream-billing';
import { pushLog } from './logs';
import type { Credential } from './types';

/** 主签到时点(UTC)。03:17 UTC = 11:17 北京时间,避开整点的上游高峰 */
export const CHECKIN_UTC_HOUR = 3;
export const CHECKIN_UTC_MINUTE = 17;

/**
 * 主时点后仍有未签到凭证时的补签间隔(分钟),按序取用。
 * 递增而非固定,避免上游持续故障时高频重试;用尽后等到次日主时点。
 */
export const CATCHUP_DELAYS_MIN = [10, 30, 60, 120];

/** 距下一个主签到时点的毫秒数 */
export function delayUntilNextCheckin(now: Date = new Date()): number {
  const next = new Date(now);
  next.setUTCHours(CHECKIN_UTC_HOUR, CHECKIN_UTC_MINUTE, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * 依据本轮结果决定下一次执行的时机。
 *
 * - 仍有未签到凭证且补签次数未用尽 → 按 CATCHUP_DELAYS_MIN 取下一次补签间隔
 * - 否则(全部完成,或补签已用尽) → 等到次日主时点,补签计数归零
 *
 * 纯函数,便于测试;定时器的实际调度在 server.ts。
 */
export function planNextCheckinRun(
  pending: number,
  catchupIndex: number,
  now: Date = new Date(),
): { delayMs: number; catchupIndex: number } {
  if (pending > 0 && catchupIndex < CATCHUP_DELAYS_MIN.length) {
    return {
      delayMs: CATCHUP_DELAYS_MIN[catchupIndex] * 60_000,
      catchupIndex: catchupIndex + 1,
    };
  }
  return { delayMs: delayUntilNextCheckin(now), catchupIndex: 0 };
}

export interface AutoCheckinReport {
  triggered: boolean;
  autoCheckin: boolean;
  total: number;
  /** 本次实际领取成功 */
  ok: number;
  /** 今日已签到,未重复调用领取接口 */
  already: number;
  skipped: number;
  /** 有效活动未开放而跳过 */
  inactive: number;
  /** 凭证无领取权限而跳过 */
  blocked: number;
  /** 活动进行中且有权限,但本次未能确认签到成功 —— 需要补签 */
  pending: number;
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
 * 执行一轮自动签到。幂等安全:无论何时被调用(手动、补签或 cron),上游保证每日一次。
 */
export async function performAutoCheckins(env: ScheduledEnv): Promise<AutoCheckinReport> {
  const store = getTokenStore(env as never);
  const settings = await store.getSettings();
  const report: AutoCheckinReport = {
    triggered: true,
    autoCheckin: settings.autoCheckin,
    total: 0,
    ok: 0,
    already: 0,
    skipped: 0,
    inactive: 0,
    blocked: 0,
    pending: 0,
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
      // 今日已签到:跳过领取调用(上游对重复签到返回 10001),省一次上游请求。
      // 补签轮次里大多数凭证走这一分支,整轮成本仅为一次只读查询。
      if (status.todayCheckedIn) {
        report.already += 1;
        continue;
      }

      const result = await fetchDailyCheckin(credential, env as never);
      // 领取接口对"今日已签到"不抛错而是正常返回(credit=0 + 提示语):
      // 这是与其他端的竞态(状态查询后、领取前被抢先签了),不计入本次领取成功。
      if (result.credit > 0) {
        report.ok += 1;
      } else {
        report.already += 1;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (/签到被拒绝/.test(message)) {
        // 权限类拒绝是持久状态(凭证形态问题),补签无意义
        report.failures.push(`${credential.name}: ${message}`);
      } else if (/签到失败/.test(message)) {
        // 上游业务错误:可能瞬时,留待补签
        report.failures.push(`${credential.name}: ${message}`);
        report.pending += 1;
      } else {
        // 状态查询/网络类失败:签到状态未知,留待补签
        report.skipped += 1;
        report.pending += 1;
      }
    }
  }

  pushLog(
    'info',
    'auto_checkin',
    `自动签到完成：领取 ${report.ok}，已签到 ${report.already}，待补签 ${report.pending}` +
      `（共 ${report.total}：未开放 ${report.inactive}，无权限 ${report.blocked}，跳过 ${report.skipped}）` +
      (report.season ? `｜第 ${report.season} 期 ${report.activityName ?? ''}，至 ${report.endTime ?? '—'}` : ''),
    {
      total: report.total,
      ok: report.ok,
      already: report.already,
      inactive: report.inactive,
      blocked: report.blocked,
      skipped: report.skipped,
      pending: report.pending,
      season: report.season,
      activityName: report.activityName,
      endTime: report.endTime,
      failures: report.failures.slice(0, 5),
    },
  );

  return report;
}
