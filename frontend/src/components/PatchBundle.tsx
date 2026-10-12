import type { ReviewLine } from '../lib/review';
import type { PatchRecord } from '../lib/api';
import { bundleApplied, bundlePending, bundleStats } from '../lib/bundle';

interface PatchBundleProps {
  patches: PatchRecord[];
  brief: ReviewLine[];
  busy: boolean;
  blocked: boolean;
  onApply: () => void;
  onVerify?: () => void;
  onReject: () => void;
  onRollback?: () => void;
}

/**
 * 同一回合拆出的多张卡，顶上这一条才是「一个决定」。
 * 单张卡还在下面，这里不替换、不改 patch-card 类名。
 */
export function PatchBundle({
  patches,
  brief,
  busy,
  blocked,
  onApply,
  onVerify,
  onReject,
  onRollback,
}: PatchBundleProps) {
  const stats = bundleStats(patches);
  const pending = bundlePending(patches);
  const applied = bundleApplied(patches);
  if (patches.length < 2) return null;

  return (
    <div className="patch-bundle">
      <div className="patch-bundle-head">
        <span className="patch-bundle-k">组合包</span>
        <span className="patch-bundle-n">
          {stats.files} 个文件
          <span className="add"> +{stats.added}</span>
          <span className="del"> −{stats.removed}</span>
        </span>
      </div>
      {pending.length > 0 && brief.length > 0 && (
        <div className="review-brief patch-bundle-brief">
          {brief.map((line) => (
            <div key={line.key} className={`review-line review-${line.tone}`}>
              <span className="review-k">{line.label}</span>
              <span className="review-v">{line.text}</span>
            </div>
          ))}
        </div>
      )}
      <div className="patch-bundle-actions">
        {pending.length > 0 && (
          <>
            {onVerify && (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={busy || blocked}
                onClick={onVerify}
                title="这一组一起应用，再编译、跑测试"
              >
                {busy ? '处理中…' : '应用这一组并验收'}
              </button>
            )}
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy || blocked}
              onClick={onApply}
              title="这一组一起写盘，只打一张快照"
            >
              {busy ? '应用中…' : `应用这一组（${pending.length}）`}
            </button>
            <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={onReject}>
              丢掉这一组
            </button>
          </>
        )}
        {applied && onRollback && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={onRollback}
            title="回到这一组写盘前的底片"
          >
            回滚这一组
          </button>
        )}
      </div>
    </div>
  );
}
