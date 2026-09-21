import { useRef, useState } from 'react';

/**
 * 三栏之间的拖拽分隔条。
 *
 * 用 Pointer Events 而不是鼠标事件：不用额外处理 pointercancel，
 * 且拖拽过程中用 setPointerCapture 保证光标移出窗口也不会丢事件。
 * 组件本身无状态 —— 宽度由父级持有，这里只报告「这一帧移动了多少像素」。
 */
interface SplitterProps {
  onResize: (deltaX: number) => void;
  onReset?: () => void;
  label: string;
}

export function Splitter({ onResize, onReset, label }: SplitterProps) {
  const lastX = useRef<number | null>(null);
  const [active, setActive] = useState(false);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    lastX.current = event.clientX;
    setActive(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (lastX.current === null) return;
    const delta = event.clientX - lastX.current;
    if (delta === 0) return;
    lastX.current = event.clientX;
    onResize(delta);
  };

  const stop = (event: React.PointerEvent<HTMLDivElement>) => {
    if (lastX.current === null) return;
    lastX.current = null;
    setActive(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div
      className={`splitter${active ? ' active' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={onReset ? '拖动调整宽度，双击恢复默认' : '拖动调整宽度'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onReset}
    />
  );
}
