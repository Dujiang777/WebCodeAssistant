/** 当前文件的跳转大纲。只做启发式，不接 LSP。 */

export interface OutlineItem {
  line: number;
  name: string;
  kind: 'class' | 'method' | 'heading';
}

export function outlineOf(path: string, text: string): OutlineItem[] {
  const name = (path.split('/').pop() ?? path).toLowerCase();
  if (name.endsWith('.java') || name.endsWith('.kt')) return javaOutline(text);
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) return jsOutline(text);
  if (/\.(md|mdx)$/.test(name)) return mdOutline(text);
  return genericOutline(text);
}

function javaOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split(/\n/);
  const type = /^\s*(public|protected|private)?\s*(static\s+)?(final\s+)?(class|interface|enum|record)\s+(\w+)/;
  const method = /^\s*(public|protected|private)\s+(static\s+)?[\w.<>,\[\]?]+\s+(\w+)\s*\(/;
  for (let i = 0; i < lines.length; i++) {
    const typeHit = type.exec(lines[i]);
    if (typeHit) {
      items.push({ line: i + 1, name: typeHit[5], kind: 'class' });
      continue;
    }
    const methodHit = method.exec(lines[i]);
    if (methodHit && methodHit[3] !== 'if' && methodHit[3] !== 'for' && methodHit[3] !== 'while') {
      items.push({ line: i + 1, name: methodHit[3] + '()', kind: 'method' });
    }
  }
  return items.slice(0, 48);
}

function jsOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split(/\n/);
  const re = /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|const|let|type|interface)\s+(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const hit = re.exec(lines[i]);
    if (hit) {
      items.push({
        line: i + 1,
        name: hit[5],
        kind: hit[4] === 'class' || hit[4] === 'interface' ? 'class' : 'method',
      });
    }
  }
  return items.slice(0, 48);
}

function mdOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split(/\n/);
  for (let i = 0; i < lines.length; i++) {
    const hit = /^(#{1,3})\s+(.+)$/.exec(lines[i]);
    if (hit) items.push({ line: i + 1, name: hit[2].trim(), kind: 'heading' });
  }
  return items.slice(0, 48);
}

function genericOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split(/\n/);
  const re = /^\s*(def|fn|func|public|class)\s+(\w+)/;
  for (let i = 0; i < lines.length; i++) {
    const hit = re.exec(lines[i]);
    if (hit) items.push({ line: i + 1, name: hit[2], kind: 'method' });
  }
  return items.slice(0, 48);
}
