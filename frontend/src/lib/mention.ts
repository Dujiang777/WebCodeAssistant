/**
 * 输入框 @文件 / @符号。
 *
 * 不必先打开文件。打 @UserService 就推进上下文，发送时展开成真实路径，
 * 并告诉后端这是本轮要看的文件（工具档才能走 DIRECT/EDIT，而不是再空转一轮）。
 */

import type { CompletionSymbol } from './api';

export interface MentionQuery {
  start: number;
  query: string;
}

export interface MentionHit {
  kind: 'file' | 'symbol';
  label: string;
  insert: string;
  detail: string;
  file: string;
}

export function mentionAt(text: string, caret: number): MentionQuery | null {
  const left = text.slice(0, caret);
  const match = left.match(/@([^\s@]*)$/);
  if (!match || match.index === undefined) return null;
  return { start: match.index, query: match[1] };
}

export function applyMention(text: string, caret: number, insert: string): { text: string; caret: number } {
  const at = mentionAt(text, caret);
  if (!at) {
    const next = `${text.replace(/\s+$/, '')} ${insert} `;
    return { text: next, caret: next.length };
  }
  const next = `${text.slice(0, at.start)}${insert} ${text.slice(caret)}`;
  const pos = at.start + insert.length + 1;
  return { text: next, caret: pos };
}

export function collectMentions(text: string): string[] {
  const found = text.match(/@([^\s@]+)/g);
  if (!found) return [];
  return found.map((item) => item.slice(1));
}

export function resolveToken(token: string, files: string[]): string | null {
  const needle = token.replace(/^`|`$/g, '').toLowerCase();
  if (!needle) return null;
  const exact = files.find((file) => file.toLowerCase() === needle || file.replace(/\\/g, '/').toLowerCase() === needle);
  if (exact) return exact;
  const byBase = files.filter((file) => basename(file).toLowerCase() === needle);
  if (byBase.length === 1) return byBase[0];
  const noExt = files.filter((file) => stem(basename(file)).toLowerCase() === needle);
  if (noExt.length === 1) return noExt[0];
  const contains = files.filter((file) => basename(file).toLowerCase().includes(needle));
  return contains.length === 1 ? contains[0] : byBase[0] ?? noExt[0] ?? null;
}

export function fileHits(files: string[], query: string, limit = 8): MentionHit[] {
  const needle = query.trim().toLowerCase();
  const scored = files
    .map((file) => ({ file, score: fileScore(file, needle) }))
    .filter((item) => item.score > 0 || needle.length === 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
    .slice(0, limit);
  return scored.map((item) => ({
    kind: 'file',
    label: basename(item.file),
    insert: `@${basename(item.file)}`,
    detail: item.file,
    file: item.file,
  }));
}

export function symbolHits(symbols: CompletionSymbol[], query: string, limit = 8): MentionHit[] {
  const needle = query.trim().toLowerCase();
  return symbols
    .filter((symbol) => !needle || symbol.name.toLowerCase().includes(needle))
    .slice(0, limit)
    .map((symbol) => ({
      kind: 'symbol' as const,
      label: symbol.name,
      insert: `@${symbol.name}`,
      detail: `${symbol.file}:${symbol.line}`,
      file: symbol.file,
    }));
}

export function mergeHits(files: MentionHit[], symbols: MentionHit[], limit = 10): MentionHit[] {
  const seen = new Set<string>();
  const out: MentionHit[] = [];
  for (const hit of [...symbols, ...files]) {
    const key = `${hit.kind}:${hit.file}:${hit.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

export function expandComposer(
  text: string,
  files: string[],
  extra: { token: string; file: string }[] = [],
): { content: string; focusFile: string | null } {
  const resolved: string[] = [];
  const known = new Map(extra.map((item) => [item.token.toLowerCase(), item.file]));
  for (const token of collectMentions(text)) {
    const mapped = known.get(token.toLowerCase()) ?? resolveToken(token, files);
    if (mapped && !resolved.includes(mapped)) resolved.push(mapped);
  }
  if (resolved.length === 0) {
    return { content: text, focusFile: null };
  }
  const block = `先看这些：\n${resolved.map((file) => `- \`${file}\``).join('\n')}\n\n`;
  return { content: block + text, focusFile: resolved[0] };
}

function fileScore(file: string, needle: string): number {
  if (!needle) return 1;
  const name = basename(file).toLowerCase();
  const path = file.toLowerCase();
  if (name === needle || stem(name) === needle) return 100;
  if (name.startsWith(needle)) return 80;
  if (name.includes(needle)) return 50;
  if (path.includes(needle)) return 20;
  return 0;
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] ?? path;
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}
