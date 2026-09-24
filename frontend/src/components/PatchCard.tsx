import { useMemo } from 'react';

import type { BlastRadius, BuildResult, FlagView, PatchRecord } from '../lib/api';
import { parseUnifiedDiff } from '../lib/diff';
import { BlastRadiusBar } from './BlastRadiusBar';
import { CompileStrip } from './CompileStrip';
import { FeatureFlagCard } from './FeatureFlagCard';
import { PrPreviewPanel } from './PrPreviewPanel';
import { CheckIcon, CloseIcon, DiffIcon } from './icons';

/**
 * 对话流里的补丁卡片。
 *
 * 这是整个产品的核心交互：AI 产出 diff → 用户在这里看到「改了什么、有多大影响」→
 * 决定应用还是丢弃。所以卡片默认就把关键上下文摊开（前若干行 diff + 增删行数 + 影响面），
 * 而不是缩成一个「有 1 个补丁」的提示。
 *
 * 卡片在两个阶段展示不同的证据：
 *   - **待确认**：风险条（改了哪些类、谁在调用、有没有碰鉴权/支付、有没有测试）——
 *     这是「敢不敢点」的依据；
 *   - **已应用**：编译结果（真跑一次构建）—— 这是「改对没有」的依据。
 */
interface PatchCardProps {
  patch: PatchRecord;
  busy: boolean;
  radius: BlastRadius | null;
  radiusLoading: boolean;
  radiusError: string | null;
  /** 特性开关分析结果（功能 16）。pending 时才有意义。 */
  flag: FlagView | null;
  flagLoading: boolean;
  flagError: string | null;
  flagAcked: boolean;
  onAckFlag: (patchId: string, acked: boolean) => void;
  compileBusy: boolean;
  compile: BuildResult | null;
  onApply: (patch: PatchRecord) => void;
  onReject: (patch: PatchRecord) => void;
  onView: (patch: PatchRecord) => void;
  onCompile: (patch: PatchRecord) => void;
  onFixFromCompile: (patch: PatchRecord, result: BuildResult) => void;
  onOpenRef: (file: string, line: number | null) => void;
}

const PREVIEW_LINE_LIMIT = 26;

interface PreviewLine {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
}

function buildPreview(diffText: string): { lines: PreviewLine[]; hidden: number } {
  const parsed = parseUnifiedDiff(diffText);
  const lines: PreviewLine[] = [];
  for (const hunk of parsed.hunks) {
    lines.push({ kind: 'hunk', text: hunk.header });
    for (const line of hunk.lines) {
      lines.push({ kind: line.kind, text: line.text });
    }
  }
  if (lines.length <= PREVIEW_LINE_LIMIT) {
    return { lines, hidden: 0 };
  }
  return { lines: lines.slice(0, PREVIEW_LINE_LIMIT), hidden: lines.length - PREVIEW_LINE_LIMIT };
}

const GUTTER: Record<PreviewLine['kind'], string> = {
  add: '+',
  del: '-',
  context: ' ',
  hunk: '',
};

export function PatchCard({
  patch,
  busy,
  radius,
  radiusLoading,
  radiusError,
  flag,
  flagLoading,
  flagError,
  flagAcked,
  onAckFlag,
  compileBusy,
  compile,
  onApply,
  onReject,
  onView,
  onCompile,
  onFixFromCompile,
  onOpenRef,
}: PatchCardProps) {
  const parsed = useMemo(() => parseUnifiedDiff(patch.diff), [patch.diff]);
  const preview = useMemo(() => buildPreview(patch.diff), [patch.diff]);

  const fileName = patch.file.split('/').pop() ?? patch.file;
  const dir = patch.file.includes('/') ? patch.file.slice(0, patch.file.lastIndexOf('/')) : '';

  const statusText =
    patch.status === 'pending' ? '待确认' : patch.status === 'applied' ? '已应用' : '已拒绝';
  const statusColor =
    patch.status === 'pending' ? 'var(--violet)' : patch.status === 'applied' ? 'var(--lime)' : 'var(--fg-3)';

  // 改动行为且还没确认「开关关闭时的旧路径」→ 应用按钮锁住。
  // 后端也会独立挡一次（FLAG_ACK_REQUIRED），这里只是不让用户点了才吃一个报错。
  const flagBlocksApply = patch.status === 'pending' && Boolean(flag?.required) && !flagAcked;

  return (
    <div className="patch-card">
      <div className="patch-head">
        <DiffIcon size={13} />
        <button className="patch-file" title={`在编辑器中打开 ${patch.file}`} onClick={() => onOpenRef(patch.file, null)}>
          {dir && <span style={{ color: 'var(--fg-3)' }}>{dir}/</span>}
          <span style={{ color: 'var(--fg-0)' }}>{fileName}</span>
        </button>
        <span className="patch-stat">
          <span className="add">+{parsed.added}</span>
          <span style={{ color: 'var(--fg-3)' }}> / </span>
          <span className="del">-{parsed.removed}</span>
        </span>
      </div>

      <div className="patch-preview">
        {preview.lines.map((line, index) => (
          <div key={index} className={`patch-line ${line.kind}`}>
            <span className="patch-gutter">{GUTTER[line.kind]}</span>
            <span>{line.text || ' '}</span>
          </div>
        ))}
        {preview.hidden > 0 && (
          <div className="patch-line context" style={{ color: 'var(--fg-3)' }}>
            <span className="patch-gutter" />
            <span>… 其余 {preview.hidden} 行，点「完整对比」查看</span>
          </div>
        )}
        {preview.lines.length === 0 && (
          <div className="patch-line context" style={{ color: 'var(--fg-3)' }}>
            <span className="patch-gutter" />
            <span>（这个补丁没有可预览的变更块）</span>
          </div>
        )}
      </div>

      {patch.status === 'pending' && (
        <>
          <FeatureFlagCard
            view={flag}
            loading={flagLoading}
            error={flagError}
            acked={flagAcked}
            onAck={(acked) => onAckFlag(patch.id, acked)}
          />
          <PrPreviewPanel patchId={patch.id} fileName={fileName} />
          <BlastRadiusBar
            radius={radius}
            loading={radiusLoading}
            error={radiusError}
            onOpenRef={onOpenRef}
          />
        </>
      )}

      {patch.status !== 'pending' && (
        <CompileStrip
          busy={compileBusy}
          result={compile}
          onCompile={() => onCompile(patch)}
          onFix={(result) => onFixFromCompile(patch, result)}
          onOpenIssue={onOpenRef}
        />
      )}

      <div className="patch-actions">
        <button className="btn btn-sm" onClick={() => onView(patch)}>
          完整对比
        </button>

        {patch.status === 'pending' && (
          <>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || flagBlocksApply}
              title={flagBlocksApply ? '请先确认特性开关关闭时的旧路径' : '应用补丁并写盘'}
              onClick={() => onApply(patch)}
            >
              {busy ? <span className="spinner" /> : <CheckIcon size={12} />}
              应用并写盘
            </button>
            <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => onReject(patch)}>
              <CloseIcon size={12} />
              丢弃
            </button>
          </>
        )}

        <span className="patch-status" style={{ color: statusColor }}>
          {statusText}
          {patch.appliedAt ? ` · ${new Date(patch.appliedAt).toLocaleTimeString()}` : ''}
        </span>
      </div>
    </div>
  );
}
