/**
 * 进程级兜底:上游连接异常不得拖垮整个网关。
 *
 * 背景:上游在响应中途断开 TCP 时,undici 会在 body controller 已释放后
 * 再次调用 error(),把 `TypeError: terminated`(cause 为 UND_ERR_SOCKET /
 * "other side closed")抛到事件循环顶层。这类错误只影响单个在途请求,但会
 * 变成 uncaughtException —— 按 Node 默认语义整个进程退出,所有客户端同时断服。
 *
 * 策略:只把已识别的网络层噪音降级为告警;其它未捕获异常仍按默认语义退出
 * (交由容器 restart 策略拉起),避免把真正的逻辑缺陷一并吞掉。
 */

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  cause?: unknown;
}

/** 上游连接层噪音(断流 / RST / 半开连接),与业务逻辑无关,忽略不影响正确性。 */
export function isRecoverableUpstreamError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as ErrorLike;
  const cause = (e.cause && typeof e.cause === 'object' ? e.cause : undefined) as ErrorLike | undefined;

  for (const code of [e.code, cause?.code]) {
    // undici 的网络错误统一带 UND_ERR_* 前缀
    if (typeof code === 'string' && (code.startsWith('UND_ERR') || /^(ECONNRESET|EPIPE|ECONNABORTED)$/.test(code))) {
      return true;
    }
  }

  const text = [
    typeof e.message === 'string' ? e.message : '',
    typeof cause?.message === 'string' ? cause.message : '',
  ].join(' ');
  return /terminated|other side closed|socket hang up/i.test(text);
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 安装进程兜底。返回卸载函数(供测试在用例结束后还原)。
 */
export function installProcessGuards(): () => void {
  const onUncaught = (err: unknown): void => {
    if (isRecoverableUpstreamError(err)) {
      console.warn('[codebuddy-gateway] 忽略上游连接异常(仅影响该请求):', describe(err));
      return;
    }
    console.error('[codebuddy-gateway] 未捕获异常,进程退出:', err);
    process.exit(1);
  };
  const onRejection = (reason: unknown): void => {
    if (isRecoverableUpstreamError(reason)) {
      console.warn('[codebuddy-gateway] 忽略上游连接异常(仅影响该请求):', describe(reason));
      return;
    }
    console.error('[codebuddy-gateway] 未处理的 Promise 拒绝,进程退出:', reason);
    process.exit(1);
  };

  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  return () => {
    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onRejection);
  };
}
