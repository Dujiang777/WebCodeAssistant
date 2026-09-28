import { useEffect, useState } from 'react';

/**
 * 品牌终端窗：登录页左侧的「活体广告」。
 *
 * 静态特性列表说服不了人，一个会自己动起来的终端可以：它循环演示
 * 「提问 → AI 亮证据 → 出补丁 → 编译通过」的完整闭环，正好是本产品
 * 与「套壳聊天」们的分水岭。打字节奏刻意放慢（60ms/字符）——
 * 快了像假数据，慢了才像有人在真的敲键盘。
 */
interface Line {
  /** 行首徽记：> 是用户输入，→ 是工具动作，✓ 是结果。 */
  mark: string;
  text: string;
  tone: 'user' | 'tool' | 'ok';
}

const SCRIPT: Line[] = [
  { mark: '>', text: '把这个类改成构造器注入', tone: 'user' },
  { mark: '→', text: 'read_file UserService.java', tone: 'tool' },
  { mark: '→', text: 'grep_field injection · 2 hits', tone: 'tool' },
  { mark: '+', text: 'diff: UserService.java +9 / -4', tone: 'tool' },
  { mark: '✓', text: '补丁已应用 · 编译通过 · 0 错误', tone: 'ok' },
];

const TYPE_MS = 60;
const LINE_PAUSE = 320;
const LOOP_PAUSE = 2600;

export function TypingTerminal() {
  const [lineIndex, setLineIndex] = useState(0);
  const [chars, setChars] = useState(0);

  useEffect(() => {
    const current = SCRIPT[lineIndex];
    if (chars < current.text.length) {
      const timer = window.setTimeout(() => setChars((value) => value + 1), TYPE_MS);
      return () => window.clearTimeout(timer);
    }
    if (lineIndex < SCRIPT.length - 1) {
      const timer = window.setTimeout(() => {
        setLineIndex((value) => value + 1);
        setChars(0);
      }, LINE_PAUSE);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(() => {
      setLineIndex(0);
      setChars(0);
    }, LOOP_PAUSE);
    return () => window.clearTimeout(timer);
  }, [lineIndex, chars]);

  // 已完成的行 + 正在打的一行（含光标）
  const done = SCRIPT.slice(0, lineIndex);
  const active = SCRIPT[lineIndex];

  return (
    <div className="term-win" aria-hidden="true">
      <div className="term-bar">
        <span className="term-dot red" />
        <span className="term-dot yellow" />
        <span className="term-dot green" />
        <span className="term-title">web-code-assistant — live</span>
      </div>
      <div className="term-body">
        {done.map((line) => (
          <div key={line.text} className={`term-line term-${line.tone}`}>
            <em>{line.mark}</em>
            {line.text}
          </div>
        ))}
        <div className={`term-line term-${active.tone}`}>
          <em>{active.mark}</em>
          {active.text.slice(0, chars)}
          <span className="term-caret" />
        </div>
      </div>
    </div>
  );
}
