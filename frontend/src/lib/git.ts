/**
 * 状态栏 Git：提交说明从已应用补丁里抽，不必人再想一遍。
 */

import type { PatchRecord } from './api';

export function suggestCommit(patches: PatchRecord[]): string {
  const applied = patches
    .filter((patch) => patch.status === 'applied')
    .slice()
    .sort((a, b) => (b.appliedAt ?? '').localeCompare(a.appliedAt ?? ''))
    .slice(0, 6);
  if (applied.length === 0) return '';
  const files = applied.map((patch) => patch.file.split('/').pop() ?? patch.file);
  const uniqueFiles = [...new Set(files)];
  const summary = applied.map((patch) => patch.summary?.trim()).find((text) => text);
  const fileLine = uniqueFiles.join('、');
  return summary ? `${summary}\n\n${fileLine}` : `应用补丁：${fileLine}`;
}
