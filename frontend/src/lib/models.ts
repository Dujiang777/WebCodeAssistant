/**
 * 模型配置页的纯函数：预设家、筛选、一轮大概多少分。
 *
 * 页面只负责点选；这里把「该填哪家地址」和「这张卡贵不贵」收成可复用的判断，
 * 避免对话框和卡片各写一套字符串。
 */

import type { ModelOption } from './api';

export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl: string;
  homepage: string;
  hint: string;
}

/** 常见 OpenAI 兼容入口。点一下填地址，Key 仍要自己贴。 */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    homepage: 'https://platform.deepseek.com/api_keys',
    hint: '国内常用，官方兼容 /v1',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    homepage: 'https://platform.openai.com/api-keys',
    hint: '官方 GPT',
  },
  {
    id: 'moonshot',
    name: 'Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    homepage: 'https://platform.moonshot.cn/console/api-keys',
    hint: '长上下文',
  },
  {
    id: 'qwen',
    name: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    homepage: 'https://dashscope.console.aliyun.com/apiKey',
    hint: '阿里云兼容模式',
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    homepage: 'https://cloud.siliconflow.cn/account/ak',
    hint: '一家入口、多家模型',
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    homepage: 'https://console.groq.com/keys',
    hint: '极速推理',
  },
];

export type ModelSource = 'all' | 'platform' | 'byok';
export type ModelTier = 'all' | 'LIGHT' | 'STANDARD' | 'FLAGSHIP';

/** 一轮常见用量：读当前文件约 1500 in + 回大约 600 out。自带 Key 记 0。 */
export function turnCost(model: ModelOption): number {
  if (model.byok) return 0;
  return Math.max(1, Math.round((1500 * model.per1kInput + 600 * model.per1kOutput) / 1000));
}

export function costLabel(model: ModelOption): string {
  if (model.byok) return '自带 Key · 免积分';
  return `约 ${turnCost(model)} 分/轮 · 每千 ${model.per1kInput}/${model.per1kOutput}`;
}

export function contextLabel(window: number | null | undefined): string {
  if (window == null || window <= 0) return '上下文未标';
  if (window >= 1000) return `${Math.round(window / 1000)}K 上下文`;
  return `${window} 上下文`;
}

export function filterModels(
  models: ModelOption[],
  query: string,
  source: ModelSource,
  tier: ModelTier,
): ModelOption[] {
  const needle = query.trim().toLowerCase();
  return models.filter((model) => {
    if (source === 'platform' && model.byok) return false;
    if (source === 'byok' && !model.byok) return false;
    if (tier !== 'all' && model.tier !== tier) return false;
    if (!needle) return true;
    return [model.displayName, model.modelKey, model.providerName]
      .some((part) => part.toLowerCase().includes(needle));
  });
}

export function matchPreset(baseUrl: string): ProviderPreset | null {
  const normalized = normalizeUrl(baseUrl);
  if (!normalized) return null;
  return PROVIDER_PRESETS.find((preset) => normalizeUrl(preset.baseUrl) === normalized) ?? null;
}

function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '').toLowerCase();
}
