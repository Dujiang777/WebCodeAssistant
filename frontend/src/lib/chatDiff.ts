/**
 * 模型有时不调 propose_patch，把 unified diff 贴进对话。
 * 展示前拆掉这段，避免聊天气泡变成一长串 ---/+++。
 */
export function stripEmbeddedDiff(text: string): { prose: string; hadDiff: boolean } {
  if (!text) {
    return { prose: '', hadDiff: false };
  }
  let hadDiff = false;
  let out = text.replace(/```(?:diff|patch|udiff)?[^\n]*\n[\s\S]*?(```|$)/gi, (block) => {
    if (/@@/.test(block) || /---\s/.test(block)) {
      hadDiff = true;
      return '';
    }
    return block;
  });
  const bare = out.search(/(^|\n)--- /);
  if (bare >= 0 && /@@/.test(out.slice(bare))) {
    hadDiff = true;
    out = out.slice(0, bare === 0 ? 0 : bare);
  }
  return { prose: out.trim(), hadDiff };
}
