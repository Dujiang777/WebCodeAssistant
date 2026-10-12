import { useEffect, useMemo, useRef, useState } from 'react';

import type { AuthUser } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { lastIdePath } from '../lib/router';
import { TerminalMark } from '../components/icons';
import '../styles/gate.css';

/**
 * 产品入口长页。进产品的门都开新标签，这一页自己留着。
 * 配色跟 Darkroom Brass 是一家：象牙纸面 + 黄铜，不走别人的浅绿杂志风。
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

const BEFORE = `public class UserService {
  private UserRepository repo;

  public User getById(Long id) {
    return repo.find(id).orElseThrow();
  }
}`;

const AFTER = `public class UserService {
  private final UserRepository repo;

  public UserService(UserRepository repo) {
    this.repo = repo;
  }
}`;

export function HomePage({ user, onLogout }: HomePageProps) {
  const [active, setActive] = useState('hero');
  const [play, setPlay] = useState(0);
  const [copied, setCopied] = useState<'gitee' | 'github' | null>(null);
  const holdRef = useRef(0);
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

  useEffect(() => {
    const reveals = document.querySelectorAll('.gate-reveal');
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add('in');
        });
      },
      { threshold: 0.14, rootMargin: '0px 0px -8% 0px' },
    );
    reveals.forEach((node) => io.observe(node));
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setPlay(2);
      return;
    }
    const id = window.setInterval(() => {
      if (Date.now() < holdRef.current) return;
      setPlay((n) => (n + 1) % FLOW.length);
    }, 2800);
    return () => window.clearInterval(id);
  }, []);

  const copy = async (which: 'gitee' | 'github') => {
    const ok = await copyText(which === 'gitee' ? GITEE : GITHUB);
    if (!ok) return;
    setCopied(which);
    window.setTimeout(() => setCopied(null), 1600);
  };

  const pick = (n: number) => {
    setPlay(n);
    holdRef.current = Date.now() + 10000;
  };

  const pauseLoop = () => {
    holdRef.current = Number.MAX_SAFE_INTEGER;
  };

  const resumeLoop = () => {
    holdRef.current = Date.now() + 600;
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
            <TerminalMark size={15} />
          </span>
          <span>
            <b>WCA</b>
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
          <p className="gate-kicker">暗房里的编码助手</p>
          <h1>
            模型会写。
            <br />
            你来拍板。
          </h1>
          <p className="gate-lead">
            左边真实文件树，中间 Monaco，右边对话。它只能出补丁卡；
            你没点应用，磁盘不会动。下面这张工作台正在把这一轮演一遍。
          </p>
          <div className="gate-hero-cta">
            <a className="gate-solid gate-lg" href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              {user ? '打开工作区' : '登录后开始'}
            </a>
            <button type="button" className="gate-ghost gate-lg" onClick={() => scrollTo('flow')}>
              看四步主循环
            </button>
          </div>
        </div>
        <div
          className={`gate-desk is-beat-${play}`}
          onMouseEnter={pauseLoop}
          onMouseLeave={resumeLoop}
        >
          <div className="gate-desk-bar">
            <i />
            <i />
            <i />
            <em>demo-java / UserService.java</em>
            <small>{FLOW[play].title} · {clock}</small>
            <b className="gate-desk-progress" style={{ width: `${((play + 1) / FLOW.length) * 100}%` }} />
          </div>
          <div className="gate-desk-body">
            <aside className="gate-pane gate-pane-tree">
              <header>文件</header>
              <ul>
                <li>src</li>
                <li className="on">UserService.java</li>
                <li>UserRepository.java</li>
                <li>pom.xml</li>
              </ul>
            </aside>
            <div className="gate-pane gate-pane-code">
              <header>{play >= 2 ? '编辑器 · 预览未写盘' : '编辑器'}</header>
              <div className="gate-code-stack">
                <pre className="is-before">{BEFORE}</pre>
                <pre className="is-after">{AFTER}</pre>
                <span className="gate-scan" />
              </div>
            </div>
            <aside className="gate-pane gate-pane-chat">
              <header>对话</header>
              <div className={`gate-bubble${play === 0 ? ' is-typing' : ''}`}>
                把这个改成构造器注入
                {play === 0 && <i className="gate-caret" />}
              </div>
              <div className="gate-patch">
                <b>待确认 · UserService.java</b>
                <code>+ private final UserRepository repo;</code>
                <small>影响面 中 · 未写盘</small>
                <a href={appHref(enter)} target="_blank" rel="noopener noreferrer">
                  应用并写盘
                </a>
              </div>
              <div className="gate-done">补丁已应用 · 正在编译</div>
            </aside>
          </div>
        </div>
        <ol className="gate-beats">
          {FLOW.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={play === item.id ? 'on' : ''}
                onClick={() => pick(item.id)}
              >
                <em>{item.no}</em>
                {item.title}
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className="gate-band gate-reveal" id="how">
        <div className="gate-band-head">
          <p className="gate-kicker">人在环上</p>
          <h2>会改代码，不等于能写盘。</h2>
          <p>
            静态 diff 只是展示。能核对引用、算出影响面、在编辑器里一段段预演的补丁，才是这一轮的工作量。
            提问、证据、写盘，各安其位。
          </p>
        </div>
        <div className="gate-spine">
          <article>
            <span>证据</span>
            <h3>每个结论都能点开</h3>
            <p>回答里的路径:行号是可点的。编造的引用会被标红，不会混进正文。</p>
            <a href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              打开工作台
            </a>
          </article>
          <article>
            <span>审查</span>
            <h3>改之前先看影响面</h3>
            <p>补丁卡算出改了谁、谁在调用、有没有踩鉴权或宪法。磁盘这时还是原样。</p>
            <a href={appHref(user ? '/workspaces' : '/login')} target="_blank" rel="noopener noreferrer">
              去工作区
            </a>
          </article>
          <article>
            <span>落盘</span>
            <h3>写盘只有一个按钮</h3>
            <p>工具集里没有写文件。应用才落盘，预览条明确写着未写盘。</p>
            <button type="button" onClick={() => scrollTo('flow')}>
              看四步流程
            </button>
          </article>
        </div>
      </section>

      <section className="gate-embed gate-reveal">
        <div>
          <p className="gate-kicker">三栏同一运行时</p>
          <h2>工作台就是浏览器里的仓库。</h2>
          <ol>
            <li>
              <b>文件树</b>
              真实磁盘目录。禁区硬拒绝，问 / 改 / 补丁一悬停就在。
            </li>
            <li>
              <b>编辑器</b>
              Monaco 标签页。补丁来了会从原文一段段放到改后。
            </li>
            <li>
              <b>对话</b>
              交付或教学两种口吻。补丁卡、引用、停止，都在这一栏。
            </li>
          </ol>
        </div>
        <div className="gate-code">
          <header>
            <span>HITL · propose_patch</span>
            <a href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              去试一次
            </a>
          </header>
          <pre>{`模型：读文件、搜代码、出 unified diff
你：看影响面 / 看着改 / 点「应用并写盘」
磁盘：只在 Apply 时被改写`}</pre>
        </div>
      </section>

      <section className="gate-flow gate-reveal" id="flow">
        <div className="gate-band-head">
          <p className="gate-kicker">主循环</p>
          <h2>一张补丁，怎么落到磁盘上。</h2>
          <p>它会自己往前走。点某一步，循环会停在那一幕。</p>
        </div>
        <div className="gate-flow-grid">
          <ol>
            {FLOW.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={play === item.id ? 'on' : ''}
                  onClick={() => pick(item.id)}
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
          <div className={`gate-stage stage-${FLOW[play].screen}`} key={play}>
            <p className="gate-stage-kicker">{FLOW[play].no} / {FLOW[play].title}</p>
            {play === 0 && (
              <div className="gate-stage-ask">
                <span>你</span>
                <p>把 UserService 改成构造器注入</p>
              </div>
            )}
            {play === 1 && (
              <div className="gate-stage-card">
                <b>待确认 · UserService.java</b>
                <code>+ private final UserRepository repo;</code>
                <small>影响面 中 · 0 处引用 · 未写盘</small>
              </div>
            )}
            {play === 2 && (
              <div className="gate-stage-live">
                <i /> 预览 · 未写盘 · 2 / 2
                <pre>{`  public UserService(UserRepository repo) {\n      this.repo = repo;\n  }`}</pre>
              </div>
            )}
            {play === 3 && (
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

      <section className="gate-doors gate-reveal" id="doors">
        <div className="gate-band-head">
          <p className="gate-kicker">入口</p>
          <h2>从这一页进产品，首页留在原标签。</h2>
        </div>
        <div className="gate-door-list">
          <a href={appHref(user ? '/workspaces' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>工作区</em>
            <p>克隆仓库、上传 zip、或开内置示例。代码在服务器磁盘上。</p>
            <span>新标签打开</span>
          </a>
          <a href={appHref(desk ?? enter)} target="_blank" rel="noopener noreferrer">
            <em>工作台</em>
            <p>三栏 IDE。提问、出卡、看着改、应用。</p>
            <span>{desk ? '继续上次' : '进入'}</span>
          </a>
          <a href={appHref(user ? '/models' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>模型服务</em>
            <p>选平台模型，或贴自己的 Key。试一句不走积分。</p>
            <span>配置</span>
          </a>
          <a href={appHref(user ? '/credits' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>积分中心</em>
            <p>余额、套餐、支付、流水、对账。预扣多退少补。</p>
            <span>查看</span>
          </a>
          <a href={appHref(user ? '/account' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>账号与安全</em>
            <p>邮箱验证、改密码、登录设备，逐个踢掉。</p>
            <span>打开</span>
          </a>
          <a href="https://gitee.com/du-jiangjiang/web-code-assistant" target="_blank" rel="noopener noreferrer">
            <em>Gitee 仓库</em>
            <p>源码与发行都在这。构建脚本也从这里拉。</p>
            <span>打开仓库</span>
          </a>
        </div>
      </section>

      <section className="gate-next" id="next">
        <div className="gate-next-copy">
          <p className="gate-kicker">开始</p>
          <h2>开一个工作区，问第一句。</h2>
          <p>对当前文件说「解释一下这个类」。引用能点，改动会先出卡。</p>
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
              GitHub
            </a>
          </div>
        </div>
      </section>

      <footer className="gate-foot">
        <span className="gate-mark">
          <TerminalMark size={15} />
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
