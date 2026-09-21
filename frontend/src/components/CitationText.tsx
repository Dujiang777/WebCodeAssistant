import { useMemo } from 'react';

import { indexCitations, segmentText } from '../lib/citations';

/**
 * 带「证据引用」的正文。
 *
 * 回答里的 `src/main/java/com/demo/UserService.java:18` 会被渲染成一个可点的 chip，
 * 点一下就在编辑器里打开那个文件并跳到那一行。
 *
 * 两个刻意的处理：
 *   1. **无效引用标红**。后端校验过「文件是否存在、行号是否越界」，编出来的引用
 *      不该看起来和真引用一样；
 *   2. **不改动正文**。只是把文本切成片段再渲染，用户看到的内容与模型输出的完全一致 ——
 *      隐藏或改写它说过的话，比它说错话更糟。
 */
interface CitationTextProps {
  text: string;
  /** 来自消息 meta 或实时事件；缺省时所有引用按有效渲染。 */
  citations?: unknown;
  onOpen: (file: string, line: number | null) => void;
}

const MAX_CHIP_CHARS = 52;

export function CitationText({ text, citations, onOpen }: CitationTextProps) {
  const index = useMemo(() => indexCitations(citations), [citations]);
  const segments = useMemo(() => segmentText(text, index), [text, index]);

  return (
    <>
      {segments.map((segment, position) => {
        if (segment.type === 'text') {
          return <span key={position}>{segment.value}</span>;
        }
        const label =
          segment.raw.length > MAX_CHIP_CHARS
            ? `${segment.raw.slice(0, MAX_CHIP_CHARS - 1)}…`
            : segment.raw;
        const hint = segment.valid
          ? `${segment.file}${segment.line ? ` 第 ${segment.line} 行` : ''} —— 点击在编辑器中打开`
          : `引用存疑：${segment.reason ?? '未通过校验'}\n${segment.file}`;

        return (
          <button
            key={position}
            type="button"
            className={`cite-chip${segment.valid ? '' : ' cite-chip-bad'}`}
            title={hint}
            onClick={() => onOpen(segment.file, segment.line)}
          >
            {!segment.valid && <span className="cite-chip-warn">!</span>}
            {label}
          </button>
        );
      })}
    </>
  );
}
