/**
 * 引用（cite）的文本切分与有效性索引。
 *
 * 后端已经在回合结束时校验过每条引用，但**渲染**必须在前端自己做：
 * 只有知道每个 `路径:行号` 在文本里的位置，才能把它变成一个可点的 chip。
 * 两者分工是：后端管「这条引用是不是真的」，前端管「它在哪儿、长什么样」。
 *
 * 一个细节：扫描前先把 URL 屏蔽成等长空格。否则
 * `https://repo.maven.apache.org/maven2/.../x.pom` 里的片段会变成一个假的文件引用，
 * 用户点上去只会得到一个「文件不存在」的提示。
 */

import type { Citation } from './api';

const EXTENSIONS = [
  'java', 'kt', 'kts', 'scala',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rb', 'go', 'rs', 'php', 'cs',
  'c', 'h', 'cpp', 'hpp', 'swift',
  'xml', 'yml', 'yaml', 'json', 'toml', 'properties', 'gradle',
  'sql', 'sh', 'bat', 'ps1', 'md', 'txt', 'html', 'css', 'scss', 'vue', 'svelte',
].join('|');

const CITATION_RE = new RegExp(
  `([\\w][\\w./\\\\-]*\\.(?:${EXTENSIONS}))(?!\\w)(?::(\\d{1,7})(?:\\s*[-–—]\\s*(\\d{1,7}))?)?`,
  'g',
);

const URL_RE = /\bhttps?:\/\/\S+/g;

export type Segment =
  | { type: 'text'; value: string }
  | {
      type: 'cite';
      raw: string;
      file: string;
      line: number | null;
      endLine: number | null;
      valid: boolean;
      reason: string | null;
    };

/** 校验索引的键。同一处引用在不同位置出现时共用一个键。 */
export function citationKey(file: string, line: number | null, endLine: number | null): string {
  return `${file}:${line ?? ''}:${endLine ?? ''}`;
}

/** 把后端给的 `meta.citations` 变成可 O(1) 查询的索引。 */
export function indexCitations(citations: unknown): Map<string, Citation> {
  const map = new Map<string, Citation>();
  if (!Array.isArray(citations)) return map;
  for (const item of citations as Citation[]) {
    if (!item || typeof item.file !== 'string') continue;
    map.set(citationKey(item.file, item.line ?? null, item.endLine ?? null), item);
  }
  return map;
}

function maskUrls(text: string): string {
  return text.replace(URL_RE, (match) => ' '.repeat(match.length));
}

/**
 * 把一段文本切成「普通文本」与「引用」两种片段。
 *
 * 行号用等长空格掩码后的字符串做匹配，所以下标与原文本严格对齐。
 */
export function segmentText(text: string, index?: Map<string, Citation>): Segment[] {
  if (!text) return [];

  const masked = maskUrls(text);
  const segments: Segment[] = [];
  let cursor = 0;

  CITATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CITATION_RE.exec(masked)) !== null) {
    const raw = text.slice(match.index, match.index + match[0].length);
    let file = match[1].replace(/\\/g, '/');
    while (file.startsWith('./')) file = file.slice(2);

    const line = match[2] ? Number(match[2]) : null;
    const endLine = match[3] ? Number(match[3]) : null;

    if (match.index > cursor) {
      segments.push({ type: 'text', value: text.slice(cursor, match.index) });
    }

    const known = index?.get(citationKey(file, line, endLine));
    segments.push({
      type: 'cite',
      raw,
      file,
      line,
      endLine,
      // 后端的校验结果优先；没有校验结果时（例如老消息）默认按有效渲染
      valid: known ? known.valid : true,
      reason: known ? known.reason : null,
    });
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) {
    segments.push({ type: 'text', value: text.slice(cursor) });
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', value: text });
  }
  return segments;
}

/** 统计无效引用数量，用于在消息头上挂一个「2 条引用存疑」的标记。 */
export function countInvalid(citations: unknown): number {
  const index = indexCitations(citations);
  let invalid = 0;
  index.forEach((citation) => {
    if (!citation.valid) invalid += 1;
  });
  return invalid;
}
