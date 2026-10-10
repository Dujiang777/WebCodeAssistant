/**
 * 审查简报：敢不敢点应用，三行说完。
 *
 * 影响面、宪章、PR 预演本来都在卡上，但要自己点开。这里只抽「风险 / 宪法 / 建议」，
 * 细的仍留在下面，不删。
 */

import type { BlastRadius, BuildResult, CharterAudit, TestRunResult } from './api';

export type ReviewTone = 'ok' | 'warn' | 'bad' | 'idle';

export interface ReviewLine {
  key: 'risk' | 'charter' | 'advice';
  label: string;
  text: string;
  tone: ReviewTone;
}

export function buildReview(input: {
  radius: BlastRadius | null;
  radiusLoading: boolean;
  radiusError: string | null;
  charter: CharterAudit | null;
}): ReviewLine[] {
  const { radius, radiusLoading, radiusError, charter } = input;

  let risk: ReviewLine;
  if (radiusLoading) {
    risk = { key: 'risk', label: '风险', text: '正在看影响面…', tone: 'idle' };
  } else if (radiusError) {
    risk = { key: 'risk', label: '风险', text: `影响面没看成：${radiusError}`, tone: 'warn' };
  } else if (!radius) {
    risk = { key: 'risk', label: '风险', text: '还没有影响面', tone: 'idle' };
  } else {
    const level = radius.riskLevel === 'high' ? '高' : radius.riskLevel === 'medium' ? '中' : '低';
    const tone: ReviewTone = radius.riskLevel === 'high' ? 'bad' : radius.riskLevel === 'medium' ? 'warn' : 'ok';
    risk = {
      key: 'risk',
      label: '风险',
      text: `${level} · ${radius.headline || '看过调用方了'}`,
      tone,
    };
  }

  let charterLine: ReviewLine;
  if (!charter || !charter.present) {
    charterLine = { key: 'charter', label: '宪法', text: '工作区还没写宪法', tone: 'idle' };
  } else if (charter.blocked) {
    const hit = charter.hits[0];
    charterLine = {
      key: 'charter',
      label: '宪法',
      text: hit ? `拦住了 · 命中 ${hit.needle}` : '拦住了这项改动',
      tone: 'bad',
    };
  } else {
    charterLine = { key: 'charter', label: '宪法', text: '未命中禁止项', tone: 'ok' };
  }

  let advice: ReviewLine;
  if (charter?.blocked) {
    advice = { key: 'advice', label: '建议', text: '先改宪法或丢掉这张卡', tone: 'bad' };
  } else if (radius?.riskLevel === 'high') {
    advice = { key: 'advice', label: '建议', text: '影响面大，先看调用方再验收', tone: 'warn' };
  } else if (radius && radius.tests.length === 0) {
    advice = { key: 'advice', label: '建议', text: '没有测试覆盖，应用后请跑验收', tone: 'warn' };
  } else if (radius && radius.tests.length > 0) {
    advice = {
      key: 'advice',
      label: '建议',
      text: `有 ${radius.tests.length} 个测试文件 · 适合应用并验收`,
      tone: 'ok',
    };
  } else {
    advice = { key: 'advice', label: '建议', text: '看完 diff 再决定', tone: 'idle' };
  }

  return [risk, charterLine, advice];
}

export type RecipePhase = 'apply' | 'compile' | 'test' | 'done' | 'failed';

export interface RecipeView {
  phase: RecipePhase;
  compile: BuildResult | null;
  tests: TestRunResult | null;
}

export function testSummary(result: TestRunResult): string {
  if (result.status === 'ok') {
    const run = result.totals?.run;
    return run != null ? `测试通过 · ${run} 个用例` : '测试通过';
  }
  if (result.status === 'failed') {
    const fail = (result.totals?.failures ?? 0) + (result.totals?.errors ?? 0);
    if (fail > 0) return `测试失败 · ${fail} 个用例`;
    if ((result.issues ?? []).length > 0) return `测试没跑起来 · ${result.issues?.length} 条编译诊断`;
    return '测试失败';
  }
  if (result.status === 'timeout') return '测试超时';
  return result.note || '测试未执行';
}
