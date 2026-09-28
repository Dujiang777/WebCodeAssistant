import { useEffect, useRef, useState } from 'react';

import { loadUser, subscribeSession } from '../lib/api';
import type { AuthUser } from '../lib/api';
import { navigate } from '../lib/router';
import { THEMES, applyTheme, useTheme } from '../lib/theme';
import { CreditIcon, KeyIcon, ShieldIcon, TerminalMark } from './icons';

/**
 * 头像弹出菜单 —— 用户在产品里的「自我中枢」。
 *
 * 参照成熟产品（ChatGPT / Claude / Linear）的布局语言：
 * 触发器是一颗圆形头像，点开后从头像处向上（对话输入区）或向下（顶栏）弹出菜单：
 *
 *   ┌──────────────────────┐
 *   │  身份卡：头像+名+邮箱+角色+余额 │
 *   │  ── AI 与模型 ──        │
 *   │  模型服务（配 Key / 设默认）    │
 *   │  ── 外观 ──             │
 *   │  ▣ 暗房黄铜  ▣ 墨玉翡翠  ▣ 暖纸 │
 *   │  ── 账号 ──             │
 *   │  积分中心 / 账号与安全 / 管理后台 │
 *   │  退出登录               │
 *   └──────────────────────┘
 *
 * 为什么放进对话输入区而不是只有顶栏：聊天页里用户的手永远在下半屏，
 * 最顺手的「设置入口」就在发送键旁边 —— 抬手即达，不用瞄准右上角。
 *
 * 会话状态自己订阅（loadUser + subscribeSession）：组件在任何页面都能用，
 * 不需要每层往下传 user props。
 */
export function AvatarMenu({ direction, onLogout }: {
  /** 'up' = 菜单从头像上方弹出（对话输入区用）；'down' = 下方弹出（顶栏 / 页面头用）。 */
  direction: 'up' | 'down';
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(() => loadUser());
  const [theme] = useTheme();
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => subscribeSession(setUser), []);

  // 点外面 / Esc 关闭：浮层的标准礼貌
  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  const initial = user.username.charAt(0).toUpperCase();
  const isAdmin = user.role === 'ADMIN';

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div className={`avatar-root${open ? ' open' : ''}`} ref={rootRef}>
      <button
        className="avatar-btn"
        title="账号与设置"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="avatar-face">{initial}</span>
        <span className="avatar-presence" />
      </button>

      {open && (
        <div className={`avatar-menu avatar-menu-${direction}`} role="menu" aria-label="账号与设置">
          {/* 身份卡：谁在用、什么角色、还剩多少积分，一眼确认 */}
          <div className="avatar-id">
            <span className="avatar-face avatar-face-lg">{initial}</span>
            <div className="avatar-id-text">
              <div className="avatar-id-name">
                {user.username}
                <em className={`avatar-role${isAdmin ? ' avatar-role-admin' : ''}`}>
                  {isAdmin ? '管理员' : '用户'}
                </em>
              </div>
              <div className="avatar-id-mail">{user.email ?? '未绑定邮箱'}</div>
              <button
                className={`avatar-credits${user.lowBalance ? ' low' : ''}`}
                onClick={() => go('/credits')}
                title="剩余积分。每轮对话按真实 token 用量结算。"
              >
                <CreditIcon size={12} />
                余额 {user.credits} 分
              </button>
            </div>
          </div>

          <div className="avatar-group-label">AI 与模型</div>
          <button className="avatar-item" onClick={() => go('/models')}>
            <KeyIcon size={13} />
            <span className="avatar-item-text">
              <b>模型服务</b>
              <i>配自己的 API Key（免积分）、设默认模型</i>
            </span>
          </button>

          <div className="avatar-group-label">外观 · 样式主题</div>
          <div className="avatar-themes">
            {THEMES.map((meta) => (
              <button
                key={meta.key}
                className={`avatar-theme${theme === meta.key ? ' on' : ''}`}
                title={meta.hint}
                onClick={() => applyTheme(meta.key)}
              >
                <span className="avatar-theme-swatch">
                  {meta.swatch.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
                <span className="avatar-theme-name">{meta.label}</span>
                {theme === meta.key && <span className="avatar-theme-check">✓</span>}
              </button>
            ))}
          </div>

          <div className="avatar-group-label">账号</div>
          <button className="avatar-item" onClick={() => go('/account')}>
            <ShieldIcon size={13} />
            <span className="avatar-item-text">
              <b>账号与安全</b>
              <i>邮箱验证、改密码、登录设备</i>
            </span>
          </button>
          {isAdmin && (
            <button className="avatar-item" onClick={() => go('/admin')}>
              <TerminalMark size={13} />
              <span className="avatar-item-text">
                <b>管理后台</b>
                <i>用户管理、订单与审计</i>
              </span>
            </button>
          )}

          <div className="avatar-sep" />
          <button className="avatar-item avatar-logout" onClick={() => { setOpen(false); onLogout(); }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M6 2H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14H6M10.5 11 14 8l-3.5-3M14 8H6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}
