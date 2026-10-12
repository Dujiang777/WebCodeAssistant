import { useEffect, useMemo, useState } from 'react';

import type { AuthUser } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { lastIdePath } from '../lib/router';
import { TerminalMark } from '../components/icons';
import '../styles/gate.css';

/**
 * 产品入口长页。浅底、分节、锚点导航；进产品的门都开新标签，这一页自己留着。
 * 视觉参考 Ink 那种纸面 + 深绿装置，但不改应用里的 Darkroom Brass。
 */
interface HomePageProps {
  user: AuthUser | null;
  onLogout: () => void;
}

const SECTIONS = [
  { id: 'hero', label: '首页' },
  { id: 'how', label: '能力' },
  { id: 'flow', label: '流程' },
  { id: 'doors', label: '入口' },
  { id: 'next', label: '开始' },
] as const;

const GITEE = 'https://gitee.com/du-jiangjiang/web-code-assistant.git';
const GITHUB = 'https://github.com/Dujiang777/WebCodeAssistant.git';

const FLOW = [
  {
    id: 0,
    no: '01',
    title: '你提问',
    body: '对着当前文件说话。路径、选区、@引用会跟着进这一轮。',
    screen: 'ask',
  },
  {
    id: 1,
    no: '02',
    title: '它出补丁卡',
    body: '模型只能 propose_patch。卡片上是 diff、影响面、宪章，磁盘还没动。',
    screen: 'card',
  },
  {
    id: 2,
    no: '03',
    title: '看着它改',
    body: '编辑器从原文一段段放到改后，顶上写着「预览 · 未写盘」。',
    screen: 'live',
  },
  {
    id: 3,
    no: '04',
    title: '你点应用',
    body: '唯一写盘入口。编译失败会把输出喂回去再改。',
    screen: 'apply',
  },
] as const;

export function HomePage({ user, onLogout }: HomePageProps) {
  const [active, setActive] = useState('hero');
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState<'gitee' | 'github' | null>(null);
  const desk = lastIdePath();
  const enter = user ? '/workspaces' : '/login';

  useEffect(() => {
    const nodes = SECTIONS.map((item) => document.getElementById(item.id)).filter(
      (node): node is HTMLElement => node !== null,
    );
    const io = new IntersectionObserver(
      (entries) => {
        const shown = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (shown?.target.id) setActive(shown.target.id);
      },
      { rootMargin: '-28% 0px -55% 0px', threshold: [0.15, 0.4, 0.7] },
    );
    nodes.forEach((node) => io.observe(node));
    return () => io.disconnect();
  }, []);

  const copy = async (which: 'gitee' | 'github') => {
    const ok = await copyText(which === 'gitee' ? GITEE : GITHUB);
    if (!ok) return;
    setCopied(which);
    window.setTimeout(() => setCopied(null), 1600);
  };


  const clock = useMemo(() => {
    const now = new Date();
    return now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }, []);

  return (
    <div className="gate">
      <header className="gate-nav">
        <button type="button" className="gate-brand" onClick={() => scrollTo('hero')}>
          <span className="gate-mark">
            <TerminalMark size={16} />
          </span>
          <span>
            <b>WEB CODE ASSISTANT</b>
            <i>网页版编码助手</i>
          </span>
        </button>
        <nav className="gate-links" aria-label="本页分节">
          {SECTIONS.slice(1).map((item) => (
            <button
              key={item.id}
              type="button"
              className={active === item.id ? 'on' : ''}
              onClick={() => scrollTo(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="gate-nav-actions">
          {user ? (
            <>
              <span className="gate-who">{user.username}</span>
              <a className="gate-ghost" href={appHref('/workspaces')} target="_blank" rel="noopener noreferrer">
                工作区
              </a>
              <a className="gate-solid" href={appHref(desk ?? '/workspaces')} target="_blank" rel="noopener noreferrer">
                进入工作台
              </a>
            </>
          ) : (
            <>
              <a className="gate-ghost" href={appHref('/login')} target="_blank" rel="noopener noreferrer">
                登录
              </a>
              <a className="gate-solid" href={appHref('/login')} target="_blank" rel="noopener noreferrer">
                开始使用
              </a>
            </>
          )}
        </div>
      </header>

      <section className="gate-hero" id="hero">
        <div className="gate-hero-copy">
          <p className="gate-kicker">WCA / 001 ✳</p>
          <h1>
            AI 读懂仓库。
            <br />
            <em>动手之前先给你看。</em>
          </h1>
          <p className="gate-lead">
            从一句提问，到一张可确认的补丁。左边文件树、中间真编辑器、右边对话。
            模型没有任何写盘权限 —— 你没点应用，磁盘不会动。
          </p>
          <div className="gate-hero-cta">
            <a className="gate-solid gate-lg" href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              {user ? '打开工作区' : '登录后开始'}
            </a>
            <button type="button" className="gate-ghost gate-lg" onClick={() => scrollTo('flow')}>
              看它怎么改代码 ↗
            </button>
          </div>
          <ul className="gate-pills">
            <li>页面自有证据</li>
            <li>补丁先预演</li>
            <li>写盘由你点</li>
          </ul>
        </div>
        <div className="gate-device">
          <div className="gate-phone">
            <i className="gate-notch" />
            <div className="gate-phone-bar">
              <span>WCA</span>
              <span>{clock}</span>
            </div>
            <div className="gate-phone-screen">
              <div className="gate-mini-tree">
                <i />
                <i className="on" />
                <i />
                <i />
              </div>
              <div className="gate-mini-code">
                <span>UserService.java</span>
                <pre>{`public User getById(Long id) {\n    return repo.find(id)\n        .orElseThrow();\n}`}</pre>
              </div>
              <div className="gate-mini-chat">
                <b>把这个改成构造器注入</b>
                <em>待确认 · UserService.java</em>
                <a href={appHref(enter)} target="_blank" rel="noopener noreferrer">
                  应用并写盘
                </a>
              </div>
            </div>
            <i className="gate-home-bar" />
          </div>
          <p className="gate-device-cap">工作台预览 · 入口都会开新标签</p>
        </div>
      </section>

      <section className="gate-band gate-band-ink" id="how">
        <div className="gate-band-head">
          <p className="gate-kicker">人在环上 · 会跑的界面</p>
          <h2>
            会改代码的助手，
            <br />
            需要人在环上。
          </h2>
          <p>
            静态 diff 只需展示；能核对引用、算出影响面、在编辑器里一段段预演的补丁，则需要运行。
            Web Code Assistant 把提问、证据和写盘各安其位。
          </p>
        </div>
        <div className="gate-trio">
          <article>
            <span>01 ✳</span>
            <h3>每个结论都能点开</h3>
            <p>回答里的路径:行号是可点的证据。编造的引用会被标红。</p>
            <a href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              打开工作台 ↗
            </a>
          </article>
          <article>
            <span>02 ✳</span>
            <h3>改之前先看影响面</h3>
            <p>补丁卡算出改了谁、谁在调用、有没有踩鉴权或宪法。</p>
            <a href={appHref(user ? '/workspaces' : '/login')} target="_blank" rel="noopener noreferrer">
              去工作区 ↗
            </a>
          </article>
          <article>
            <span>03 ✳</span>
            <h3>写盘只有一个按钮</h3>
            <p>工具集里没有写文件。应用才落盘，预览明确写着未写盘。</p>
            <button type="button" onClick={() => scrollTo('flow')}>
              看四步流程 ↗
            </button>
          </article>
        </div>
      </section>

      <section className="gate-embed">
        <div>
          <p className="gate-kicker">三栏 / 同一运行时</p>
          <h2>工作台融入浏览器，外壳仍是你的仓库。</h2>
          <ol>
            <li>
              <b>01 / 文件树</b>
              真实磁盘目录。禁区硬拒绝，问 / 改 / 补丁一悬停就在。
            </li>
            <li>
              <b>02 / 编辑器</b>
              Monaco 标签页。补丁来了会从原文一段段放到改后。
            </li>
            <li>
              <b>03 / 对话</b>
              交付或教学两种口吻。补丁卡、引用、停止，都在这一栏。
            </li>
          </ol>
        </div>
        <div className="gate-code">
          <header>
            <span>HITL · propose_patch</span>
            <a href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              去试一次 ↗
            </a>
          </header>
          <pre>{`模型：读文件、搜代码、出 unified diff
你：看影响面 / 看着改 / 点「应用并写盘」
磁盘：只在 Apply 时被改写`}</pre>
        </div>
      </section>

      <section className="gate-flow" id="flow">
        <div className="gate-band-head">
          <p className="gate-kicker">一眼知晓，一步可达</p>
          <h2>看一张补丁，如何真正落地。</h2>
          <p>下面四步是产品主循环。点序号，右侧装置会跟着切画面。</p>
        </div>
        <div className="gate-flow-grid">
          <ol>
            {FLOW.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={step === item.id ? 'on' : ''}
                  onClick={() => setStep(item.id)}
                >
                  <em>{item.no}</em>
                  <span>
                    <b>{item.title}</b>
                    {item.body}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className={`gate-stage stage-${FLOW[step].screen}`}>
            <p className="gate-stage-kicker">{FLOW[step].no} / {FLOW[step].title}</p>
            {step === 0 && (
              <div className="gate-stage-ask">
                <span>你</span>
                <p>把 UserService 改成构造器注入</p>
              </div>
            )}
            {step === 1 && (
              <div className="gate-stage-card">
                <b>待确认 · UserService.java</b>
                <code>+ private final UserRepository repo;</code>
                <small>影响面 中 · 0 处引用 · 未写盘</small>
              </div>
            )}
            {step === 2 && (
              <div className="gate-stage-live">
                <i /> 预览 · 未写盘 · 2 / 2
                <pre>{`  public UserService(UserRepository repo) {\n      this.repo = repo;\n  }`}</pre>
              </div>
            )}
            {step === 3 && (
              <div className="gate-stage-apply">
                <p>补丁已应用。正在编译…</p>
                <a className="gate-solid" href={appHref(enter)} target="_blank" rel="noopener noreferrer">
                  去真实工作台
                </a>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="gate-doors" id="doors">
        <div className="gate-band-head">
          <p className="gate-kicker">所需能力，皆有入口</p>
          <h2>通过这一页，跳进产品里的每一扇门。</h2>
        </div>
        <div className="gate-door-grid">
          <a href={appHref(user ? '/workspaces' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>01</em>
            <b>工作区</b>
            <p>克隆仓库、上传 zip、或开内置示例。代码在服务器磁盘上。</p>
            <span>新标签打开 ↗</span>
          </a>
          <a href={appHref(desk ?? enter)} target="_blank" rel="noopener noreferrer">
            <em>02</em>
            <b>工作台</b>
            <p>三栏 IDE。提问、出卡、看着改、应用。</p>
            <span>{desk ? '继续上次' : '进入'} ↗</span>
          </a>
          <a href={appHref(user ? '/models' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>03</em>
            <b>模型服务</b>
            <p>选平台模型，或贴自己的 Key。试一句不走积分。</p>
            <span>配置 ↗</span>
          </a>
          <a href={appHref(user ? '/credits' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>04</em>
            <b>积分中心</b>
            <p>余额、套餐、支付、流水、对账。预扣多退少补。</p>
            <span>查看 ↗</span>
          </a>
          <a href={appHref(user ? '/account' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>05</em>
            <b>账号与安全</b>
            <p>邮箱验证、改密码、登录设备，逐个踢掉。</p>
            <span>打开 ↗</span>
          </a>
          <a href="https://gitee.com/du-jiangjiang/web-code-assistant" target="_blank" rel="noopener noreferrer">
            <em>06</em>
            <b>Gitee 仓库</b>
            <p>源码与发行都在这。构建脚本也从这里拉。</p>
            <span>打开仓库 ↗</span>
          </a>
        </div>
      </section>

      <section className="gate-next" id="next">
        <div>
          <p className="gate-kicker">下一步</p>
          <h2>写下一问，便能看见补丁。</h2>
          <p>先登录，开一个示例工作区，对当前文件说「解释一下这个类」。引用能点，改动会先出卡。</p>
          <div className="gate-hero-cta">
            <a className="gate-solid gate-lg" href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              {user ? '进入工作区' : '登录 / 注册'}
            </a>
            {user && (
              <button type="button" className="gate-ghost gate-lg" onClick={onLogout}>
                退出登录
              </button>
            )}
          </div>
        </div>
        <div className="gate-clone">
          <header>克隆这份产品</header>
          <code>{GITEE}</code>
          <div className="gate-clone-actions">
            <button type="button" onClick={() => void copy('gitee')}>
              {copied === 'gitee' ? '已复制 Gitee' : '复制 Gitee'}
            </button>
            <button type="button" onClick={() => void copy('github')}>
              {copied === 'github' ? '已复制 GitHub' : '复制 GitHub'}
            </button>
            <a href="https://github.com/Dujiang777/WebCodeAssistant" target="_blank" rel="noopener noreferrer">
              GitHub ↗
            </a>
          </div>
        </div>
      </section>

      <footer className="gate-foot">
        <span className="gate-mark">
          <TerminalMark size={16} />
        </span>
        <div>
          <b>Web Code Assistant</b>
          <p>模型只出补丁。写盘这件事，留给你。</p>
        </div>
        <div className="gate-foot-links">
          <a href={appHref('/login')} target="_blank" rel="noopener noreferrer">
            登录
          </a>
          <a href={appHref('/workspaces')} target="_blank" rel="noopener noreferrer">
            工作区
          </a>
          <a href={appHref('/models')} target="_blank" rel="noopener noreferrer">
            模型
          </a>
        </div>
      </footer>
    </div>
  );
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 同一站点的 hash 路由，新标签打开，首页自己留着。 */
function appHref(path: string): string {
  const url = new URL(window.location.href);
  url.hash = `#${path.startsWith('/') ? path : `/${path}`}`;
  return url.toString();
}
