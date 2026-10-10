/**
 * 复制到剪贴板。线上是 http://IP:端口，不属于安全上下文，
 * {@code navigator.clipboard} 会是 undefined；可选链后再 .then 会直接抛，
 * 按钮看起来像没反应。先走 Clipboard API，失败再用 execCommand 兜底。
 */
export async function copyText(text: string): Promise<boolean> {
  const value = text ?? '';
  if (!value) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 权限被拒 / 非安全上下文：落到下面的同步兜底
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.left = '-9999px';
    area.style.top = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
