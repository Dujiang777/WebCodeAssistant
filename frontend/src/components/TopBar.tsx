import { TerminalMark, ChevronIcon } from './icons';
import type { HealthInfo } from '../lib/api';

/**
 * 顶栏。左侧是品牌与面包屑，右侧是「模型连接状态 + 当前用户」。
 *
 * 这里是 2026-09-24 重构后的版本，原则是**顶栏只放「读一眼」的信息，不放工具**：
 *   - 以前宪法 / 地图 / 测试 / 快照 / 检索 / 终端 / 平行宇宙 / 工位 / 文件 / 对话
 *     十个按钮全挤在这里，顶栏变成了一排两字谜语，工作区名反而被挤没了；
 *   - 现在工具全部搬去左侧工具轨道（ToolRail），顶栏只剩三件本来就该在这里的事：
 *     我在哪（面包屑）、模型通不通（状态点）、我是谁（账号 + 退出）。
 *
 * 把模型状态放在顶栏而不是设置页：这个工具最常见的故障就是「模型没配好」，
 * 让它常驻可见（绿点=已配置、黄点=未配置）比事后排查省事得多。
 * 检索引擎与 Redis 属于环境细节，收进它的悬停说明里，不再各占一个 chip。
 */
interface TopBarProps {
  workspaceName: string;
  filePath: string | null;
  dirty: boolean;
  health: HealthInfo | null;
  username: string;
  onBack: () => void;
  onLogout: () => void;
  pendingPatches: number;
}

export function TopBar({
  workspaceName,
  filePath,
  dirty,
  health,
  username,
  onBack,
  onLogout,
  pendingPatches,
}: TopBarProps) {
  const modelReady = health?.modelConfigured ?? false;

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
        <span className="crumbs-ws">{workspaceName}</span>
        {filePath ? (
          <>
            <span className="crumbs-sep">/</span>
            <span className="crumbs-file">{filePath}</span>
            {dirty && <span className="dirty-mark" title="有未保存的修改" />}
          </>
        ) : null}
      </div>

      <div className="topbar-spacer" />

      {pendingPatches > 0 && (
        <span className="chip" style={{ color: 'var(--violet)', borderColor: 'var(--violet-dim)' }}>
          待确认补丁 {pendingPatches}
        </span>
      )}

      <span
        className="chip"
        title={
          modelReady
            ? `模型：${health?.model ?? '已配置'}　·　检索引擎：${health?.grepEngine ?? '未知'}　·　Redis：${health?.redisAvailable ? '可用' : '降级'}`
            : '未配置模型，仅可浏览与编辑文件'
        }
      >
        <span className={`dot ${modelReady ? 'dot-ok' : 'dot-warn'}`} />
        {modelReady ? health?.model ?? '模型已就绪' : '模型未配置'}
      </span>

      <span className="chip" title={`已登录：${username}`}>
        {username}
      </span>
      <button className="btn btn-ghost btn-sm" onClick={onLogout}>
        退出
      </button>
    </header>
  );
}
