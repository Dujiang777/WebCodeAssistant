/**
 * 前端侧的最小 unified diff 解析。
 *
 * 用途单一：把后端推过来的补丁拆成「文件 + 变更块」，好在卡片上渲染一个行级缩略预览。
 * 真正的对比视图交给 Monaco 的 DiffEditor；这里不做任何 apply 逻辑 ——
 * 补丁的合法性由后端在生成时就校验过了。
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'context';
  text: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface ParsedDiff {
  oldPath: string | null;
  newPath: string | null;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

export function parseUnifiedDiff(diffText: string): ParsedDiff {
  const result: ParsedDiff = { oldPath: null, newPath: null, hunks: [], added: 0, removed: 0 };
  if (!diffText) return result;

  const lines = diffText.replace(/\r\n/g, '\n').split('\n');
  let current: DiffHunk | null = null;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('--- ')) {
      result.oldPath = cleanPath(line.slice(4));
      inHunk = false;
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      result.newPath = cleanPath(line.slice(4));
      continue;
    }
    if (line.startsWith('@@')) {
      current = { header: line, lines: [] };
      result.hunks.push(current);
      inHunk = true;
      continue;
    }
    if (!inHunk || !current) {
      // diff --git / index / mode 之类的头部，前端不需要
      // eslint-disable-next-line no-continue
      continue;
    }
    if (line.startsWith('\\')) {
      continue;
    }

    const marker = line.length > 0 ? line[0] : ' ';
    const text = line.length > 0 ? line.slice(1) : '';
    if (marker === '+') {
      current.lines.push({ kind: 'add', text });
      result.added += 1;
    } else if (marker === '-') {
      current.lines.push({ kind: 'del', text });
      result.removed += 1;
    } else if (marker === ' ') {
      current.lines.push({ kind: 'context', text });
    }
  }

  return result;
}

function cleanPath(raw: string): string | null {
  let path = raw.trim();
  const tab = path.indexOf('\t');
  if (tab >= 0) path = path.slice(0, tab).trim();
  if (path === '/dev/null') return null;
  if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2);
  return path.replace(/\\/g, '/');
}

/** 由 diff 结果还原「应用后的完整文件内容」，供 Monaco DiffEditor 的右半侧使用。 */
export function applyDiffToText(originalText: string, diffText: string): string {
  const parsed = parseUnifiedDiff(diffText);
  if (parsed.hunks.length === 0) return originalText;

  const original = originalText.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let cursor = 0;

  for (const hunk of parsed.hunks) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
    const oldStart = match ? Math.max(0, Number(match[1]) - 1) : cursor;

    for (let i = cursor; i < oldStart && i < original.length; i += 1) {
      output.push(original[i]);
    }
    cursor = oldStart;

    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        output.push(line.text);
      } else if (line.kind === 'del') {
        cursor += 1;
      } else {
        output.push(line.text);
        cursor += 1;
      }
    }
  }
  for (let i = cursor; i < original.length; i += 1) {
    output.push(original[i]);
  }
  return output.join('\n');
}
