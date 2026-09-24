import type { ReactNode } from 'react';

import {
  ChatIcon,
  EyeIcon,
  FlaskIcon,
  ForkIcon,
  HistoryIcon,
  MapIcon,
  PanelLeftIcon,
  ScrollDocIcon,
  SearchIcon,
  TerminalIcon,
  TerminalMark,
} from './icons';

/**
 * 工具轨道 —— 工作台最左侧那一条竖排图标栏。
 *
 * 为什么要有它：这些能力原来全部平铺在顶栏上，变成一排两字按钮
 * （宪法 / 地图 / 测试 / 快照 / 检索 / 终端 / 平行宇宙 / 工位），
 * 问题有三个：
 *   1. 两字中文看不出是什么，也不说什么时候该用它；
 *   2. 顶栏被工具占满，工作区名、模型状态这些「读一眼」的信息反而被挤到边上；
 *   3. 面板开关（文件树 / 对话）和「打开一个工具」混在一起，是两种不同性质的控件。
 *
 * 现在按「性质」分三组，用分隔线隔开：
 *   - 项目工具：对当前仓库做一次性的动作（宪法 / 地图 / 测试 / 快照 / 检索 / 终端）；
 *   - AI 能力：跟本轮对话直接相关的观察与推演（平行宇宙 / 工位）；
 *   - 面板开关：改变布局（文件树 / 对话）。
 *
 * 悬停时从按钮右侧飘出一张两行小卡片：**第一行中文名、第二行「什么时候用它」**。
 * 只飘名字是不够的 —— 「组件地图」这四个字并不能告诉你此刻该不该点它；
 * 补上一句用途，才真正做到「不用点开就知道要不要用」。
 * `title` 仍保留完整说明 —— 自检脚本是按它来找按钮的。
 */

interface ToolRailProps {
  constitutionExists: boolean;
  deskVisible: boolean;
  treeVisible: boolean;
  chatVisible: boolean;
  /** 此刻有几步正被拦下等人放行 —— 工位图标上要能一眼看见。 */
  activeGates: number;
  onOpenConstitution: () => void;
  onOpenSpringMap: () => void;
  onOpenTests: () => void;
  onOpenSnapshots: () => void;
  onOpenSemantic: () => void;
  onOpenTerminal: () => void;
  onOpenWhatIf: () => void;
  onToggleDesk: () => void;
  onToggleTree: () => void;
  onToggleChat: () => void;
}

interface ItemProps {
  label: string;
  hint: string;
  icon: ReactNode;
  active?: boolean;
  alert?: boolean;
  muted?: boolean;
  badge?: number;
  onClick: () => void;
}

function RailButton({ label, hint, icon, active, alert, muted, badge, onClick }: ItemProps) {
  const classes = ['rail-btn'];
  if (active) classes.push('active');
  if (alert) classes.push('alert');
  if (muted) classes.push('muted');

  return (
    <button className={classes.join(' ')} title={hint} aria-label={label} onClick={onClick}>
      {icon}
      {badge && badge > 0 ? <span className="rail-badge">{badge}</span> : null}
      <span className="rail-tip" aria-hidden="true">
        <span className="rail-tip-name">{label}</span>
        <span className="rail-tip-hint">{hint}</span>
      </span>
    </button>
  );
}

export function ToolRail({
  constitutionExists,
  deskVisible,
  treeVisible,
  chatVisible,
  activeGates,
  onOpenConstitution,
  onOpenSpringMap,
  onOpenTests,
  onOpenSnapshots,
  onOpenSemantic,
  onOpenTerminal,
  onOpenWhatIf,
  onToggleDesk,
  onToggleTree,
  onToggleChat,
}: ToolRailProps) {
  return (
    <nav className="rail" aria-label="工具">
      <div className="rail-mark">
        <TerminalMark size={18} />
      </div>

      <div className="rail-group">
        <RailButton
          label="仓库宪法"
          hint={
            constitutionExists
              ? '查看 / 编辑仓库宪法（已生效）'
              : '配置仓库宪法 —— 最高优先级的硬规则，Agent 只能遵守、不能修改'
          }
          muted={!constitutionExists}
          icon={<ScrollDocIcon size={17} />}
          onClick={onOpenConstitution}
        />
        <RailButton
          label="组件地图"
          hint="Spring 组件地图 —— 扫出 Bean / HTTP 端点 / 依赖注入关系"
          icon={<MapIcon size={17} />}
          onClick={onOpenSpringMap}
        />
        <RailButton
          label="测试套件"
          hint="运行测试套件，失败可一键交给 AI 修复"
          icon={<FlaskIcon size={17} />}
          onClick={onOpenTests}
        />
        <RailButton
          label="快照回滚"
          hint="快照与回滚 —— 应用补丁前自动打点，任何时候能退回去"
          icon={<HistoryIcon size={17} />}
          onClick={onOpenSnapshots}
        />
        <RailButton
          label="语义检索"
          hint="语义检索 —— 用自然语言找代码，而不是猜关键词"
          icon={<SearchIcon size={17} />}
          onClick={onOpenSemantic}
        />
        <RailButton
          label="工作区终端"
          hint="终端 —— 在工作区里手动执行命令（AI 无此能力）"
          icon={<TerminalIcon size={17} />}
          onClick={onOpenTerminal}
        />
      </div>

      <div className="rail-sep" />

      <div className="rail-group">
        <RailButton
          label="平行宇宙"
          hint="平行宇宙 What-if —— 在影子工作区里试改动，左右对比，默认不合并"
          icon={<ForkIcon size={17} />}
          onClick={onOpenWhatIf}
        />
        <RailButton
          label="Agent 工位"
          hint={
            activeGates > 0
              ? `Agent 工位 —— 有 ${activeGates} 步正被拦下，等你放行`
              : 'Agent 工位 —— 实时看它在你的仓库里打开了什么、光标在哪、草稿怎么长出来'
          }
          icon={<EyeIcon size={17} />}
          active={deskVisible}
          alert={activeGates > 0}
          badge={activeGates}
          onClick={onToggleDesk}
        />
      </div>

      <div className="rail-spacer" />
      <div className="rail-sep" />

      <div className="rail-group">
        <RailButton
          label={treeVisible ? '隐藏文件树' : '显示文件树'}
          hint="显示 / 隐藏文件树"
          icon={<PanelLeftIcon size={17} />}
          active={treeVisible}
          muted={!treeVisible}
          onClick={onToggleTree}
        />
        <RailButton
          label={chatVisible ? '隐藏对话' : '显示对话'}
          hint="显示 / 隐藏 AI 对话面板"
          icon={<ChatIcon size={17} />}
          active={chatVisible}
          muted={!chatVisible}
          onClick={onToggleChat}
        />
      </div>
    </nav>
  );
}
