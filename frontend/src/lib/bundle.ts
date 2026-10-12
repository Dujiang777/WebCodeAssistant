/**
 * 补丁组合包：同一回合拆出来的多张卡，是一个决定。
 */

import type { BlastRadius, CharterAudit, PatchRecord } from './api';
import { parseUnifiedDiff } from './diff';
import { buildReview } from './review';
import type { ReviewLine, ReviewTone } from './review';

export function bundleKey(patches: PatchRecord[]): string {
  return patches
    .map((patch) => patch.id)
    .slice()
    .sort()
    .join(',');
}

export function bundleStats(patches: PatchRecord[]): { files: number; added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const patch of patches) {
    const parsed = parseUnifiedDiff(patch.diff);
    added += parsed.added;
    removed += parsed.removed;
  }
  return { files: patches.length, added, removed };
}

export function bundlePending(patches: PatchRecord[]): PatchRecord[] {
  return patches.filter((patch) => patch.status === 'pending');
}

export function bundleApplied(patches: PatchRecord[]): boolean {
  return patches.length > 0 && patches.every((patch) => patch.status === 'applied');
}

export function mergeReview(
  patches: PatchRecord[],
  of: {
    radius: (id: string) => BlastRadius | null;
    radiusLoading: (id: string) => boolean;
    radiusError: (id: string) => string | null;
    charter: (id: string) => CharterAudit | null;
  },
): ReviewLine[] {
  const lines = patches.map((patch) =>
    buildReview({
      radius: of.radius(patch.id),
      radiusLoading: of.radiusLoading(patch.id),
      radiusError: of.radiusError(patch.id),
      charter: of.charter(patch.id),
    }),
  );
  if (lines.length === 0) return [];
  return [
    pickLine(
      lines.map((item) => item[0]),
      'risk',
      '风险',
    ),
    pickLine(
      lines.map((item) => item[1]),
      'charter',
      '宪法',
    ),
    pickLine(
      lines.map((item) => item[2]),
      'advice',
      '建议',
    ),
  ];
}

function pickLine(items: ReviewLine[], key: ReviewLine['key'], label: string): ReviewLine {
  const worst = items.reduce((acc, item) => (rank(item.tone) > rank(acc.tone) ? item : acc), items[0]);
  if (key === 'risk' && items.length > 1) {
    const highs = items.filter((item) => item.tone === 'bad').length;
    if (highs > 0) {
      return { key, label, text: `${highs} 个文件风险高 · ${worst.text}`, tone: 'bad' };
    }
  }
  if (key === 'advice' && items.length > 1 && worst.tone !== 'idle') {
    return { key, label, text: `这一组 ${items.length} 个文件 · ${worst.text}`, tone: worst.tone };
  }
  return worst;
}

function rank(tone: ReviewTone): number {
  if (tone === 'bad') return 3;
  if (tone === 'warn') return 2;
  if (tone === 'ok') return 1;
  return 0;
}
