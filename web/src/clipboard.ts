/**
 * 剪贴板写入（带非安全上下文回退）。
 *
 * 网关以明文 HTTP 提供服务，从局域网 IP 访问时（如 http://192.168.1.246:8787）
 * **不是安全上下文**。这里有两个坑，都踩过：
 *
 * 坑一：旧版 Chrome 在该环境下 `navigator.clipboard` 为 undefined，直接调用抛错。
 *
 * 坑二（更隐蔽）：新版 Chrome **提供** `navigator.clipboard`，但 `writeText`
 * 会以 `NotAllowedError` **异步拒绝**。早期实现写成「有 writeText 就调用并
 * `return true`」，把拒绝吞进 `.catch` 里 —— 于是弹「已复制」但剪贴板是空的，
 * 而回退分支在 `else` 里永远走不到。
 * **Key 明文只下发一次，谎报成功等于让用户永久丢失这个 Key。**
 *
 * 因此现在的顺序是：**先同步试 execCommand**。
 *   - `document.execCommand('copy')` 同步返回真实结果，不要求安全上下文；
 *   - 它要求调用发生在**用户手势**内，所以必须第一个执行，不能排在 await 之后。
 * 只有它失败时，才 `await` Clipboard API 并采用其**真实**结果。
 *
 * 用法（在 setup 中）：
 *   const copy = useCopy();
 *   await copy(text, '已复制该 Key');
 */
import { useMessage } from 'naive-ui';

/**
 * 同步复制（execCommand 回退路径）。
 *
 * 必须同步调用：脱离用户手势后 execCommand 会返回 false。
 * 实测明文 HTTP + 局域网 IP 下，夹在 click 处理函数内同步调用返回 true。
 */
function copyViaExecCommand(text: string): boolean {
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
 * 异步复制（推荐入口）：返回**真实**成败。
 *
 * execCommand 分支在函数体开头同步执行，仍处于用户手势内；
 * 它失败时才进入异步分支并等待真实结果，不再出现「乐观返回 true」。
 */
export async function copyText(text: string): Promise<boolean> {
  if (copyViaExecCommand(text)) return true;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // 权限被拒或非安全上下文，如实返回失败
      return false;
    }
  }
  return false;
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
    const ok = await copyText(text);
    if (ok) message.success(successMessage);
    else message.error('复制失败，请手动选中文本');
    return ok;
  };
}
