/**
 * 主题系统：整套 UI 的换肤层。
 *
 * 实现方式是「CSS 变量分组 + data-theme 属性」：global.css 的 :root 定义默认主题
 * （暗房黄铜），`[data-theme='emerald']` / `[data-theme='ivory']` 覆盖同一批变量。
 * 组件永远只消费变量，不感知主题名 —— 这样新增一套主题只需要加一段变量组，
 * 不需要动任何组件。
 *
 * Monaco 是唯一的例外：编辑器主题是 JS 定义的，没法吃 CSS 变量，所以
 * applyTheme 里做联动（浅色纸墨用 vs，其余用 wca-dark）。
 *
 * 多实例同步（TopBar 的头像菜单和 composer 的头像菜单同时开着选主题）用
 * 一个 window 自定义事件广播，比 localStorage 事件更直接。
 */

export type ThemeName = 'brass' | 'emerald' | 'ivory';

export interface ThemeMeta {
  key: ThemeName;
  label: string;
  hint: string;
  /** 主题选择器里的三段色卡（主底 / 次底 / 强调色），纯展示用。 */
  swatch: [string, string, string];
}

export const THEMES: ThemeMeta[] = [
  {
    key: 'brass',
    label: '暗房黄铜',
    hint: '暖调近黑 + 黄铜金。默认主题，暗房里冲胶片的那种温润。',
    swatch: ['#0a0907', '#272119', '#e8b45a'],
  },
  {
    key: 'emerald',
    label: '墨玉翡翠',
    hint: '深绿黑底 + 翡翠绿强调。长时间盯屏更冷一点、更静一点。',
    swatch: ['#060a08', '#182a20', '#3ddc97'],
  },
  {
    key: 'ivory',
    label: '暖纸墨字',
    hint: '纸白底 + 深墨字 + 熟铜强调。白天 / 强光环境用，护眼不刺眼。',
    swatch: ['#f4f0e6', '#ffffff', '#9c6d14'],
  },
];

const STORAGE_KEY = 'wca.theme';

export function loadTheme(): ThemeName {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === 'emerald' || raw === 'ivory' ? raw : 'brass';
}

/** 当前主题对应的 Monaco 主题名（挂载编辑器时的初值用）。 */
export function monacoThemeForUi(): string {
  return loadTheme() === 'ivory' ? 'wca-light' : 'wca-dark';
}

const THEME_EVENT = 'wca:theme';

/** 应用主题：写 DOM 属性 + 持久化 + Monaco 联动 + 广播给所有 useTheme 实例。 */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(STORAGE_KEY, theme);
  try {
    // monaco 模块随包加载，这里一定已就绪；编辑器还没挂载时 setTheme 也无害
    void import('./monaco').then(({ setMonacoTheme }) => setMonacoTheme(theme));
  } catch {
    // 主题切换不该因为编辑器联动失败而中断
  }
  window.dispatchEvent(new CustomEvent<ThemeName>(THEME_EVENT, { detail: theme }));
}

export function initTheme(): void {
  // 只落 DOM，不广播 —— 首屏，还没有任何订阅者
  document.documentElement.dataset.theme = loadTheme();
}

import { useEffect, useState } from 'react';

/** 主题的 React 订阅：多组件同时订阅，切换时一起更新。 */
export function useTheme(): [ThemeName, (next: ThemeName) => void] {
  const [theme, setTheme] = useState<ThemeName>(loadTheme);

  useEffect(() => {
    const onTheme = (event: Event) => setTheme((event as CustomEvent<ThemeName>).detail);
    window.addEventListener(THEME_EVENT, onTheme);
    return () => window.removeEventListener(THEME_EVENT, onTheme);
  }, []);

  return [theme, applyTheme];
}
