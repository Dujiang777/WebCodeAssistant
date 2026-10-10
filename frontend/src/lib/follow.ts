/**
 * 对着补丁继续说。
 *
 * 主圈以前断在「出一张卡」：要接着改只能在空输入框另起一句，模型容易丢掉这张卡。
 * 这里把「按这张再改 / 只要这几行 / 丢掉重来」和「点 diff 某一行」收成同一套提示词，
 * 卡片和完整对比共用，输入框里永远带着路径、状态和原文。
 */

import type { BuildResult, ChatMessage, PatchRecord } from './api';
import type { LiveTurn } from './chat';

export type FollowKind = 'revise' | 'narrow' | 'redo';

export type DiffAskKind = 'explain' | 'edit' | 'usages';

export interface DiffLineAsk {
  file: string;
  line: number;
  side: 'original' | 'modified';
  text: string;
  kind: DiffAskKind;
}

export function followPrompt(kind: FollowKind, patch: PatchRecord): string {
  const file = `\`${patch.file}\``;
  const summary = patch.summary?.trim() || '（无摘要）';
  const clip = clipDiff(patch.diff);
  if (kind === 'revise') {
    return (
      `按这张补丁继续改 ${file}（${statusLabel(patch)}，${summary}）。` +
      `不要另起炉灶，基于当前这版再出一张补丁。\n\n\`\`\`diff\n${clip}\n\`\`\`\n\n我还想：`
    );
  }
  if (kind === 'narrow') {
    return (
      `只要 ${file} 里这几处改动，其它不要动。当前摘要：${summary}\n\n` +
      `\`\`\`diff\n${clip}\n\`\`\`\n\n请收成更小的一版。`
    );
  }
  return (
    `丢掉 ${file} 这张补丁，按我上一条原问题重做一版。不要沿用下面的写法：${summary}\n\n` +
    `\`\`\`diff\n${clip}\n\`\`\``
  );
}

export function diffLinePrompt(ask: DiffLineAsk): string {
  const side = ask.side === 'modified' ? '应用之后' : '磁盘上现在';
  const clip = ask.text.length > 400 ? `${ask.text.slice(0, 400)}…` : ask.text;
  const where = `\`${ask.file}\` ${side}第 ${ask.line} 行`;
  if (ask.kind === 'edit') {
    return `把 ${where} 改成：\n\`\`\`\n${clip}\n\`\`\`\n`;
  }
  if (ask.kind === 'usages') {
    return (
      `这一行还在哪些地方被用到？列出调用方和改它可能波及的地方。\n\n` +
      `${where}：\n\`\`\`\n${clip}\n\`\`\``
    );
  }
  return (
    `解释一下这一行：它在做什么、这次改动为什么要动它、有没有风险。\n\n` +
    `${where}：\n\`\`\`\n${clip}\n\`\`\``
  );
}

function clipDiff(diff: string, max = 1800): string {
  const text = diff.replace(/\r\n/g, '\n').trim();
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function statusLabel(patch: PatchRecord): string {
  if (patch.status === 'applied') return '已应用';
  if (patch.status === 'rejected') return '已拒绝';
  return '待确认';
}

export interface ChecklistItem {
  id: string;
  label: string;
  /** plan = set_plan 步骤，用户可勾；fact = 补丁/编译，跟着真实状态走。 */
  kind: 'plan' | 'fact';
  done: boolean;
}

/**
 * 本轮清单：优先用正在跑的回合，回合结束后落到最近一条助手消息。
 * 新回合还没出计划/补丁时，继续钉着上一轮，避免「做完了也不知道做完没」。
 */
export function buildChecklist(
  turn: LiveTurn | null,
  messages: ChatMessage[],
  patches: PatchRecord[],
  compileOf: (id: string) => BuildResult | null,
  checked: Set<string>,
): ChecklistItem[] {
  const livePlan = turn?.plan ?? [];
  const plan = livePlan.length > 0 ? livePlan : lastPlan(messages);
  const liveIds = turn?.patchIds ?? [];
  const ids = liveIds.length > 0 ? liveIds : lastPatchIds(messages);
  const scoped = ids.length > 0 ? patches.filter((patch) => ids.includes(patch.id)) : [];

  const items: ChecklistItem[] = [];
  for (let index = 0; index < plan.length; index += 1) {
    const step = plan[index];
    const id = `plan:${index}`;
    items.push({ id, label: step, kind: 'plan', done: checked.has(id) });
  }

  if (scoped.length > 0) {
    const pending = scoped.filter((patch) => patch.status === 'pending').length;
    const applied = scoped.filter((patch) => patch.status === 'applied').length;
    const rejected = scoped.filter((patch) => patch.status === 'rejected').length;
    const bits = [`已出补丁 ${scoped.length} 张`];
    if (pending > 0) bits.push(`${pending} 张待确认`);
    if (applied > 0) bits.push(`${applied} 张已应用`);
    if (rejected > 0) bits.push(`${rejected} 张已丢`);
    items.push({
      id: 'fact:patches',
      label: bits.join(' · '),
      kind: 'fact',
      done: pending === 0 && applied > 0,
    });

    if (applied > 0) {
      const results = scoped
        .filter((patch) => patch.status === 'applied')
        .map((patch) => compileOf(patch.id));
      const ran = results.filter((result) => result !== null);
      const allOk = ran.length === applied && ran.every((result) => result?.status === 'ok');
      const failed = ran.some((result) => result && result.status !== 'ok');
      items.push({
        id: 'fact:compile',
        label:
          ran.length === 0
            ? `已应用 ${applied} 张 · 还没编译`
            : allOk
              ? '编译已通过'
              : failed
                ? '编译未通过'
                : '部分已编译',
        kind: 'fact',
        done: allOk,
      });
    }
  }

  return items;
}

export function checklistKey(turn: LiveTurn | null, messages: ChatMessage[]): string {
  const livePlan = turn?.plan ?? [];
  const plan = livePlan.length > 0 ? livePlan : lastPlan(messages);
  const liveIds = turn?.patchIds ?? [];
  const ids = liveIds.length > 0 ? liveIds : lastPatchIds(messages);
  return `${plan.join('\n')}::${ids.join(',')}`;
}

function lastPlan(messages: ChatMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const plan = message.meta?.plan;
    if (Array.isArray(plan) && plan.length > 0) {
      return plan.map((step) => String(step)).filter((step) => step.length > 0);
    }
  }
  return [];
}

function lastPatchIds(messages: ChatMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    const ids = message.meta?.patches;
    if (Array.isArray(ids) && ids.length > 0) {
      return ids.map(String);
    }
  }
  return [];
}
