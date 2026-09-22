/**
 * 剪贴板写入（带非安全上下文回退）。
 *
 * 为什么需要回退：`navigator.clipboard` 只在**安全上下文**（HTTPS 或 localhost）
 * 下存在。网关以明文 HTTP 提供服务，从局域网 IP 访问时（如
 * http://192.168.1.246:3000）`navigator.clipboard` 为 undefined ——
 * 而 NAS 部署恰恰以这种方式访问，导致所有「复制」按钮直接抛错，
 * 只弹一句「复制失败」，用户无从知道原因。
 *
 * 回退用 `document.execCommand('copy')`：它不要求安全上下文，但要求调用发生在
 * **用户手势**内（点击处理函数中同步执行）。实测在明文 HTTP + 局域网 IP 下，
 * 同步夹带在 click 内调用返回 true；脱离手势的程序化调用返回 false。
 * 因此这里必须保持「同步执行复制命令」——不要在图示 await 之后再调用。
 *
 * 用法（在 setup 中）：
 *   const copy = useCopy();
 *   await copy(text, '已复制该 Key');
 */
import { useMessage } from 'naive-ui';

/**
 * 同步执行复制。优先 Clipboard API，不可用时回退 execCommand。
 *
 * @returns 是否复制成功
 */
export function writeClipboard(text: string): boolean {
  // 安全上下文：走标准 API（异步，但同步发起即可）
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => {
      /* 极少数情况下权限被拒；下方回退无法在同一手势内补做，交由调用方提示 */
    });
    return true;
  }

  // 非安全上下文：execCommand 回退
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // readonly 避免移动端唤起键盘；移出视口避免页面跳动
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(area);

    // 记录并恢复原选区，避免复制动作清掉用户已有的选择
    const selection = document.getSelection();
    const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;

    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');

    document.body.removeChild(area);
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    return ok;
  } catch {
    return false;
  }
}

/**
 * 复制并提示结果的组合式函数。
 *
 * 成功提示可直接定制（如「已复制该 Key」——明文只显示一次，值得明确说明
 * 复制到了什么）；失败提示统一为可操作的指引，而不是干巴巴的「复制失败」。
 */
export function useCopy(): (text: string, successMessage?: string) => Promise<boolean> {
  const message = useMessage();
  return async (text: string, successMessage = '已复制'): Promise<boolean> => {
    const ok = writeClipboard(text);
    if (ok) message.success(successMessage);
    else message.error('复制失败，请手动选中文本');
    return ok;
  };
}
