import { TerminalMark, ChevronIcon, PlugIcon } from './icons';
import type { HealthInfo } from '../lib/api';

/**
 * 顶栏。左侧是品牌与面包屑，右侧是「模型连接状态 + 当前用户」。
 *
 * 把模型状态放在顶栏而不是设置页：这个工具最常见的故障就是「模型没配好」，
 * 让它常驻可见（绿点=已配置、黄点=未配置）比事后排查省事得多。
 */
interface TopBarProps {
  workspaceName: string;
  filePath: string | null;
  dirty: boolean;
  health: HealthInfo | null;
  username: string;
  constitutionExists: boolean;
  onBack: () => void;
  onLogout: () => void;
  onToggleTree: () => void;
  onToggleChat: () => void;
  onOpenConstitution: () => void;
  onOpenSpringMap: () => void;
  onOpenTests: () => void;
  treeVisible: boolean;
  chatVisible: boolean;
  pendingPatches: number;
}

export function TopBar({
  workspaceName,
  filePath,
  dirty,
  health,
  username,
  constitutionExists,
  onBack,
  onLogout,
  onToggleTree,
  onToggleChat,
  onOpenConstitution,
  onOpenSpringMap,
  onOpenTests,
  treeVisible,
  chatVisible,
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
        <span>{workspaceName}</span>
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

      <span className="chip" title={modelReady ? `模型：${health?.model ?? '已配置'}` : '未配置模型，仅可浏览与编辑文件'}>
        <span className={`dot ${modelReady ? 'dot-ok' : 'dot-warn'}`} />
        {modelReady ? health?.model ?? '模型已就绪' : '模型未配置'}
      </span>

      <span className="chip" title={`检索引擎：${health?.grepEngine ?? '未知'}；Redis：${health?.redisAvailable ? '可用' : '降级'}`}>
        <PlugIcon size={11} />
        {health?.grepEngine ?? '—'}
      </span>

      <button
        className={`btn btn-ghost btn-sm${constitutionExists ? '' : ' muted'}`}
        onClick={onOpenConstitution}
        title={constitutionExists ? '查看 / 编辑仓库宪法（已生效）' : '配置仓库宪法 —— 最高优先级的硬规则'}
      >
        宪法{constitutionExists ? '' : '·'}
      </button>
      <button className="btn btn-ghost btn-sm" onClick={onOpenSpringMap} title="Spring 组件地图（Bean / 端点 / 依赖注入）">
        地图
      </button>
      <button className="btn btn-ghost btn-sm" onClick={onOpenTests} title="运行测试套件，失败可一键交给 AI 修复">
        测试
      </button>

      <button
        className={`btn btn-ghost btn-sm${treeVisible ? '' : ' muted'}`}
        onClick={onToggleTree}
        title="显示 / 隐藏文件树"
      >
        文件
      </button>
      <button
        className={`btn btn-ghost btn-sm${chatVisible ? '' : ' muted'}`}
        onClick={onToggleChat}
        title="显示 / 隐藏对话"
      >
        对话
      </button>

      <span className="chip" title={`已登录：${username}`}>
        {username}
      </span>
      <button className="btn btn-ghost btn-sm" onClick={onLogout}>
        退出
      </button>
    </header>
  );
}
