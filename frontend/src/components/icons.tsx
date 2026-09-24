/**
 * 图标全部手写 SVG，不引第三方图标库：
 * 一是省掉一个依赖，二是能保证描边粗细、圆角与整套 UI 的克制风格一致。
 * 统一 16x16 视口、currentColor 描边。
 */

interface IconProps {
  size?: number;
  className?: string;
}

function base(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
}

/** 品牌标记：终端提示符 `>_` 装进直角方框 —— 「把终端与编辑器装进一个框」。 */
export function TerminalMark({ size = 22, className }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <rect x="1.6" y="1.6" width="20.8" height="20.8" rx="6" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      <path
        d="M6.2 8.2l3.9 3.8-3.9 3.8"
        stroke="var(--signal, #e8b45a)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12.6 16.4h5.4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.85" />
    </svg>
  );
}

export function FolderIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.4}>
      <path d="M1.8 4.2A1.2 1.2 0 013 3h3.1l1.3 1.6H13a1.2 1.2 0 011.2 1.2v6A1.2 1.2 0 0113 13H3a1.2 1.2 0 01-1.2-1.2V4.2z" />
    </svg>
  );
}

export function FolderOpenIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.4}>
      <path d="M1.8 4.2A1.2 1.2 0 013 3h3.1l1.3 1.6H12a1.2 1.2 0 011.2 1.2v.6" />
      <path d="M2.4 6.4h11l-1.1 6.1a1.2 1.2 0 01-1.18.98H3.3a1.2 1.2 0 01-1.18-1.04L1.6 7.1a.8.8 0 01.8-.7z" />
    </svg>
  );
}

export function FileIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.4}>
      <path d="M9.2 1.8H4.6a1.2 1.2 0 00-1.2 1.2v10a1.2 1.2 0 001.2 1.2h6.8a1.2 1.2 0 001.2-1.2V5.4l-3.4-3.6z" />
      <path d="M9.1 1.9v3.5h3.4" />
    </svg>
  );
}

export function ChevronIcon({ size = 11, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.7}>
      <path d="M6 3.5l4.5 4.5L6 12.5" />
    </svg>
  );
}

export function PlusIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.8}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

export function TrashIcon({ size = 13, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M3 4.4h10M6.4 4.4V3.2h3.2v1.2M4.4 4.4l.6 8.2a1 1 0 001 .95h4a1 1 0 001-.95l.6-8.2" />
    </svg>
  );
}

export function SaveIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M3 2.8h8L13.2 5v8.2a1 1 0 01-1 1H3.8a1 1 0 01-1-1V3.8a1 1 0 011-1z" />
      <path d="M5.4 2.8v3.8h5V2.8M5 14.2v-4h6v4" />
    </svg>
  );
}

export function RefreshIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M13.2 8a5.2 5.2 0 11-1.6-3.75" />
      <path d="M13.4 2.6v3.2h-3.2" />
    </svg>
  );
}

export function SendIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M2.4 7.4l11-4.6-4.6 11-1.9-4.5-4.5-1.9z" />
    </svg>
  );
}

export function CloseIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.6}>
      <path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" />
    </svg>
  );
}

export function CheckIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.9}>
      <path d="M2.8 8.6l3.4 3.2 7-7.6" />
    </svg>
  );
}

export function DiffIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M4.4 2.4v11.2M11.6 2.4v11.2M2.6 5.4h3.6M9.8 10.6h3.6M8.4 8h3.2M10 6.4v3.2" />
    </svg>
  );
}

export function PlugIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M5.6 2v3.2M10.4 2v3.2M3.6 5.2h8.8v2.6a4.4 4.4 0 01-8.8 0V5.2zM8 12.2v1.8" />
    </svg>
  );
}

export function SearchIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <circle cx="7" cy="7" r="4.4" />
      <path d="M10.4 10.4l3.2 3.2" />
    </svg>
  );
}

/** 盾牌：补丁风险条。 */
export function ShieldIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M8 1.8l5 1.6v4.2c0 3-2.1 5.4-5 6.4-2.9-1-5-3.4-5-6.4V3.4l5-1.6z" />
      <path d="M5.9 7.9l1.6 1.6 3-3.2" />
    </svg>
  );
}

/** 播放：触发编译验证。 */
export function PlayIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.4}>
      <path d="M4.6 2.9l8 5.1-8 5.1V2.9z" />
    </svg>
  );
}

/** 扳手：把编译错误交给 AI 修复。 */
export function WrenchIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M10.6 2.2a3.4 3.4 0 00-4 4.4l-3.9 3.9a1.3 1.3 0 001.8 1.8l3.9-3.9a3.4 3.4 0 004.4-4l-2 2-1.9-1.9 1.7-2.3z" />
    </svg>
  );
}

/** 书：教学模式。 */
export function BookIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M2.6 3.2h4.2a1.6 1.6 0 011.6 1.6v8a1.3 1.3 0 00-1.3-1.3H2.6V3.2z" />
      <path d="M13.4 3.2H9.2a1.6 1.6 0 00-1.6 1.6v8a1.3 1.3 0 011.3-1.3h4.5V3.2z" />
    </svg>
  );
}

/** 对勾火箭：交付模式（轻快给结果）。 */
export function BoltIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M8.8 1.6L3.4 9h3.4l-.6 5.4L11.6 7H8.2l.6-5.4z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * 工具轨道（ToolRail）用的图标。
 *
 * 这些工具过去是顶栏上一排两字按钮（「宪法」「地图」「测试」…），
 * 既看不出是什么、也不知道该在什么时候用。改成左侧图标条之后，
 * 每个工具需要一枚一眼能认出来的图形，所以在这里补齐。
 * ------------------------------------------------------------------ */

/** 文档条款：仓库宪法。 */
export function ScrollDocIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <rect x="3" y="2.4" width="10" height="11.2" rx="1.6" />
      <path d="M5.6 5.6h4.8M5.6 8h4.8M5.6 10.4h3" />
    </svg>
  );
}

/** 节点网络：Spring 组件地图（Bean / 端点 / 注入边）。 */
export function MapIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.4}>
      <circle cx="4.1" cy="4.2" r="1.8" />
      <circle cx="11.9" cy="5.4" r="1.8" />
      <circle cx="7.2" cy="12" r="1.8" />
      <path d="M5.7 5.3l4.7.1M4.9 5.9l1.7 4.4M11.2 7.1l-2.8 3.3" />
    </svg>
  );
}

/** 烧瓶：测试套件。 */
export function FlaskIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M6.4 2.2v4.1L3.1 11.6a1.4 1.4 0 001.2 2.2h7.4a1.4 1.4 0 001.2-2.2L9.6 6.3V2.2" />
      <path d="M5.6 2.2h4.8M4.6 9.7h6.8" />
    </svg>
  );
}

/** 时钟回拨：快照与回滚。 */
export function HistoryIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M2.7 8a5.3 5.3 0 105.3-5.3 5.3 5.3 0 00-4.2 2.1" />
      <path d="M2.4 3.3v2.6h2.6" />
      <path d="M8 5.5V8l1.8 1.1" />
    </svg>
  );
}

/** 终端窗口：手动执行命令（AI 无此能力）。 */
export function TerminalIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <rect x="1.9" y="2.9" width="12.2" height="10.2" rx="2" />
      <path d="M4.9 6.5l1.9 1.9-1.9 1.9M8.6 10.4h2.9" />
    </svg>
  );
}

/** 分叉：平行宇宙 What-if（两条走向并排推演）。 */
export function ForkIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <circle cx="4.3" cy="3.7" r="1.7" />
      <circle cx="11.7" cy="3.7" r="1.7" />
      <circle cx="8" cy="12.3" r="1.7" />
      <path d="M4.3 5.4c0 3.1 3.7 2.4 3.7 5.2M11.7 5.4c0 3.1-3.7 2.4-3.7 5.2" />
    </svg>
  );
}

/** 观察之眼：Agent 工位（看它在你的仓库里做了什么）。 */
export function EyeIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M1.8 8S4.3 3.9 8 3.9 14.2 8 14.2 8 11.7 12.1 8 12.1 1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

/** 左栏：切换文件树。 */
export function PanelLeftIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.8" />
      <path d="M6.4 2.8v10.4" />
    </svg>
  );
}

/** 对话气泡：切换 AI 对话面板。 */
export function ChatIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <path d="M13.4 8.4c0 2.6-2.4 4.7-5.4 4.7-.7 0-1.4-.1-2-.3l-3 1.1.9-2.4a4.5 4.5 0 01-1.3-3.1C2.6 5.8 5 3.7 8 3.7s5.4 2.1 5.4 4.7z" />
    </svg>
  );
}

/** 积分：一枚黄铜筹码，与「黄铜是唯一主角」的配色语言一致。 */
export function CreditIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 4.9v6.2M6.4 6.6h2.5a1.3 1.3 0 010 2.6H6.4" />
    </svg>
  );
}

/** 账号与安全：一把钥匙。 */
export function KeyIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <circle cx="5.6" cy="10.4" r="2.6" />
      <path d="M7.5 8.5L13 3M11.2 4.8l1.5 1.5M12.4 3.6l1.5 1.5" />
    </svg>
  );
}

/** 登录设备：一块屏。 */
export function DeviceIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className} strokeWidth={1.5}>
      <rect x="1.9" y="3.1" width="12.2" height="8.2" rx="1.5" />
      <path d="M5.6 13.6h4.8" />
    </svg>
  );
}

/**
 * 由文件扩展名取一个短标签 + 颜色，用于文件树上的语言标识。
 * 颜色只在少数几种语言上区分，避免变成圣诞树。
 */
export function languageBadge(path: string): { label: string; color: string } | null {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  const map: Record<string, { label: string; color: string }> = {
    java: { label: 'J', color: '#ff9d7a' },
    kt: { label: 'K', color: '#c9b8ff' },
    ts: { label: 'TS', color: '#e8c88a' },
    tsx: { label: 'TS', color: '#e8c88a' },
    js: { label: 'JS', color: '#d8c9a3' },
    jsx: { label: 'JS', color: '#d8c9a3' },
    json: { label: '{}', color: '#d8c9a3' },
    xml: { label: '<>', color: '#e8b45a' },
    yml: { label: 'Y', color: '#ff5163' },
    yaml: { label: 'Y', color: '#ff5163' },
    md: { label: 'M', color: '#8fa79a' },
    sql: { label: 'S', color: '#7fc8a9' },
    py: { label: 'Py', color: '#7fc8a9' },
    go: { label: 'Go', color: '#7fc8a9' },
    rs: { label: 'Rs', color: '#ff9d7a' },
    css: { label: '#', color: '#e8c88a' },
    sh: { label: '$', color: '#e8b45a' },
  };
  return map[ext] ?? null;
}
