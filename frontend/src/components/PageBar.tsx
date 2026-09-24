import { navigate } from '../lib/router';
import { TerminalMark, ChevronIcon } from './icons';

/**
 * 二级页面（积分中心 / 账号与安全）共用的顶栏。
 *
 * 为什么不复用 IDE 的 TopBar：那个顶栏的每一格都是工作区语境（面包屑、脏标记、
 * 待确认补丁数），拿到这里全是空的。硬塞进去只会得到一排「—」。
 * 两者共享的是**视觉语言**（品牌、胶囊按钮、chip），不是 props 形状。
 */
interface PageBarProps {
  title: string;
  subtitle: string;
  /** 余额；null 表示还没拉到（不显示，而不是显示 0）。 */
  balance: number | null;
  lowBalance: boolean;
  /** 当前停在哪个页面，用于给导航按钮加选中态。 */
  active: 'credits' | 'account';
  onBack: () => void;
  onLogout: () => void;
}

export function PageBar({ title, subtitle, balance, lowBalance, active, onBack, onLogout }: PageBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <TerminalMark size={22} className="brand-mark" />
        <div className="brand-text">
          <span className="brand-name">WEB CODE ASSISTANT</span>
          <span className="brand-sub">网页编码助手</span>
        </div>
      </div>

      <button className="btn btn-ghost btn-sm" onClick={onBack} title="返回工作区列表">
        <ChevronIcon size={11} className="flip" />
        工作区
      </button>

      <div className="crumbs">
        <span className="crumbs-ws">{title}</span>
        <span className="crumbs-sep">/</span>
        <span className="crumbs-file">{subtitle}</span>
      </div>

      <div className="topbar-spacer" />

      {balance !== null && (
        <button
          className={`chip chip-btn${lowBalance ? ' chip-warn' : ''}`}
          onClick={() => navigate('/credits')}
          title="剩余积分。每轮对话按真实 token 用量结算。"
        >
          {lowBalance && <span className="dot dot-err" />}
          积分 {balance}
        </button>
      )}

      <button
        className={`btn btn-sm ${active === 'credits' ? 'btn-primary' : 'btn-ghost'}`}
        onClick={() => navigate('/credits')}
      >
        积分中心
      </button>
      <button
        className={`btn btn-sm ${active === 'account' ? 'btn-primary' : 'btn-ghost'}`}
        onClick={() => navigate('/account')}
      >
        账号与安全
      </button>
      <button className="btn btn-ghost btn-sm" onClick={onLogout}>
        退出
      </button>
    </header>
  );
}
