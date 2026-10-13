import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';

import type { AuthUser } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { lastIdePath } from '../lib/router';
import { TerminalMark } from '../components/icons';
import '../styles/gate.css';

/**
 * 产品入口长页。进产品的门都开新标签，这一页自己留着。
 * 配色跟 Darkroom Brass 是一家：象牙纸面 + 黄铜。中英、日夜只作用在这一页。
 */
interface HomePageProps {
  user: AuthUser | null;
  onLogout: () => void;
}

type Lang = 'zh' | 'en';
type Theme = 'day' | 'night';

const GITEE = 'https://gitee.com/du-jiangjiang/web-code-assistant.git';
const GITHUB = 'https://github.com/Dujiang777/WebCodeAssistant.git';
const GITEE_PAGE = 'https://gitee.com/du-jiangjiang/web-code-assistant';
const GITHUB_PAGE = 'https://github.com/Dujiang777/WebCodeAssistant';
const CREATOR = 'Dujiang777';
const LANG_KEY = 'wca.gateLang';
const THEME_KEY = 'wca.gateTheme';

const I18N = {
  zh: {
    brandSub: '网页版编码助手',
    navHow: '能力',
    navFlow: '流程',
    navDoors: '入口',
    navNext: '开始',
    workspaces: '工作区',
    enterIde: '进入工作台',
    login: '登录',
    start: '开始使用',
    kicker: '暗房里的编码助手',
    h1a: '模型会写。',
    h1b: '你来拍板。',
    lead: '左边真实文件树，中间 Monaco，右边对话。它只能出补丁卡；你没点应用，磁盘不会动。下面这张工作台正在把这一轮演一遍。',
    heroMode: 'MODE: HITL_ENFORCED',
    heroCheck: '[ SYS.CHECK: OK ]',
    pipeTitle: 'HITL PIPELINE',
    pipeWait: '▲ 等待人类确认',
    pipeNodes: [
      { m: '输入', s: 'INPUT' },
      { m: '解析', s: 'READ' },
      { m: '生成', s: 'DIFF' },
      { m: '校验', s: 'REVIEW' },
      { m: '写盘', s: 'LOCKED' },
    ],
    openWs: '打开工作区',
    loginStart: '登录后开始',
    seeLoop: '看四步主循环',
    files: '文件',
    editor: '编辑器',
    preview: '编辑器 · 预览未写盘',
    chat: '对话',
    bubble: '把这个改成构造器注入',
    patch: '待确认 · UserService.java',
    impact: '影响面 中 · 未写盘',
    apply: '应用并写盘',
    applied: '补丁已应用 · 正在编译',
    you: '你',
    tape: ['人在环上', 'propose_patch', '预览未写盘', '写盘由你点', '引用能点开', 'HITL'],
    howKicker: '人在环上',
    howH2: '会改代码，不等于能写盘。',
    howLead: '静态 diff 只是展示。能核对引用、算出影响面、在编辑器里一段段预演的补丁，才是这一轮的工作量。提问、证据、写盘，各安其位。',
    evid: '证据',
    evidH: '每个结论都能点开',
    evidP: '回答里的路径:行号是可点的。编造的引用会被标红，不会混进正文。',
    evidA: '打开工作台',
    review: '审查',
    reviewH: '改之前先看影响面',
    reviewP: '补丁卡算出改了谁、谁在调用、有没有踩鉴权或宪法。磁盘这时还是原样。',
    reviewA: '去工作区',
    write: '落盘',
    writeH: '写盘只有一个按钮',
    writeP: '工具集里没有写文件。应用才落盘，预览条明确写着未写盘。',
    writeA: '看四步流程',
    embedKicker: '三栏同一运行时',
    embedH2: '工作台就是浏览器里的仓库。',
    tree: '文件树',
    treeP: '真实磁盘目录。禁区硬拒绝，问 / 改 / 补丁一悬停就在。',
    ed: '编辑器',
    edP: 'Monaco 标签页。补丁来了会从原文一段段放到改后。',
    talk: '对话',
    talkP: '交付或教学两种口吻。补丁卡、引用、停止，都在这一栏。',
    tryOnce: '去试一次',
    hitlModel: '模型',
    hitlModelP: '读文件、搜代码、出 unified diff',
    hitlYou: '你',
    hitlYouP: '看影响面 / 看着改 / 点「应用并写盘」',
    hitlDisk: '磁盘',
    hitlDiskP: '只在 Apply 时被改写',
    flowKicker: '主循环',
    flowH2: '一张补丁，怎么落到磁盘上。',
    flowLead: '它会自己往前走。点某一步，循环会停在那一幕。',
    live: '预览 · 未写盘 · 2 / 2',
    compiling: '补丁已应用。正在编译…',
    realIde: '去真实工作台',
    doorsKicker: '入口',
    doorsH2: '从这一页进产品，首页留在原标签。',
    d1: '工作区',
    d1p: '克隆仓库、上传 zip、或开内置示例。代码在服务器磁盘上。',
    d1a: '新标签打开',
    d2: '工作台',
    d2p: '三栏 IDE。提问、出卡、看着改、应用。',
    d2a: '进入',
    d2b: '继续上次',
    d3: '模型服务',
    d3p: '选平台模型，或贴自己的 Key。试一句不走积分。',
    d3a: '配置',
    d4: '积分中心',
    d4p: '余额、套餐、支付、流水、对账。预扣多退少补。',
    d4a: '查看',
    d5: '账号与安全',
    d5p: '邮箱验证、改密码、登录设备，逐个踢掉。',
    d5a: '打开',
    d6: 'Gitee 仓库',
    d6p: '源码与发行都在这。构建脚本也从这里拉。',
    d6a: '打开仓库',
    nextKicker: '开始',
    nextH2: '开一个工作区，问第一句。',
    nextLead: '对当前文件说「解释一下这个类」。引用能点，改动会先出卡。',
    enterWs: '进入工作区',
    signup: '登录 / 注册',
    logout: '退出登录',
    clone: '克隆这份产品',
    copiedGitee: '已复制 Gitee',
    copyGitee: '复制 Gitee',
    copiedGithub: '已复制 GitHub',
    copyGithub: '复制 GitHub',
    foot: '模型只出补丁。写盘这件事，留给你。',
    models: '模型',
    day: '日',
    night: '夜',
    madeKicker: '创作者',
    creatorRole: '独立开发 · Web Code Assistant',
    giteeLabel: 'Gitee 仓库',
    githubLabel: 'GitHub 仓库',
    cloneLabel: '克隆地址',
  },
  en: {
    brandSub: 'In-browser coding assistant',
    navHow: 'Ability',
    navFlow: 'Loop',
    navDoors: 'Doors',
    navNext: 'Start',
    workspaces: 'Workspaces',
    enterIde: 'Open the bench',
    login: 'Log in',
    start: 'Get started',
    kicker: 'Assistant in the darkroom',
    h1a: 'The model writes.',
    h1b: 'You decide.',
    lead: 'Real file tree, real Monaco, real chat. It can only propose a patch. Disk does not move until you apply.',
    heroMode: 'MODE: HITL_ENFORCED',
    heroCheck: '[ SYS.CHECK: OK ]',
    pipeTitle: 'HITL PIPELINE',
    pipeWait: '▲ WAITING FOR HUMAN INPUT',
    pipeNodes: [
      { m: 'INPUT', s: 'YOU ASK' },
      { m: 'PARSE', s: 'READ' },
      { m: 'GENERATE', s: 'DIFF' },
      { m: 'REVIEW', s: 'HOLD' },
      { m: 'WRITE', s: 'LOCKED' },
    ],
    openWs: 'Open workspaces',
    loginStart: 'Log in to start',
    seeLoop: 'Watch the four-step loop',
    files: 'Files',
    editor: 'Editor',
    preview: 'Editor · preview, not on disk',
    chat: 'Chat',
    bubble: 'Switch this to constructor injection',
    patch: 'Pending · UserService.java',
    impact: 'Impact medium · not on disk',
    apply: 'Apply to disk',
    applied: 'Applied · compiling',
    you: 'You',
    tape: ['human in the loop', 'propose_patch', 'preview first', 'you apply', 'citations open', 'HITL'],
    howKicker: 'Human in the loop',
    howH2: 'Writing code is not writing disk.',
    howLead: 'A static diff is display. A patch that checks citations, impact, and plays into the editor is the actual turn.',
    evid: 'Evidence',
    evidH: 'Every claim is clickable',
    evidP: 'Paths:lines in the answer open. Fake citations get marked red.',
    evidA: 'Open the bench',
    review: 'Review',
    reviewH: 'See the blast radius first',
    reviewP: 'The card shows who changed, who calls it, and whether auth or the constitution was hit.',
    reviewA: 'Go to workspaces',
    write: 'Write',
    writeH: 'One button writes disk',
    writeP: 'There is no write-file tool. Apply is the only path. Preview says it is not on disk.',
    writeA: 'See the loop',
    embedKicker: 'Three panes, one runtime',
    embedH2: 'The bench is your repo in the browser.',
    tree: 'File tree',
    treeP: 'Real disk. Redzones refuse. Ask / edit / patch sit on hover.',
    ed: 'Editor',
    edP: 'Monaco tabs. A patch plays from before to after, hunk by hunk.',
    talk: 'Chat',
    talkP: 'Deliver or teach. Patch cards, citations, and stop live here.',
    tryOnce: 'Try it',
    hitlModel: 'Model',
    hitlModelP: 'Read, search, emit a unified diff',
    hitlYou: 'You',
    hitlYouP: 'Inspect impact / watch it change / apply',
    hitlDisk: 'Disk',
    hitlDiskP: 'Rewritten only on Apply',
    flowKicker: 'Main loop',
    flowH2: 'How a patch actually lands.',
    flowLead: 'It walks forward on its own. Click a step to hold that frame.',
    live: 'Preview · not on disk · 2 / 2',
    compiling: 'Patch applied. Compiling…',
    realIde: 'Open the real bench',
    doorsKicker: 'Doors',
    doorsH2: 'Jump into the product. This page stays.',
    d1: 'Workspaces',
    d1p: 'Clone, zip, or open the sample. Code lives on the server disk.',
    d1a: 'New tab',
    d2: 'Workbench',
    d2p: 'Three-pane IDE. Ask, card, watch, apply.',
    d2a: 'Enter',
    d2b: 'Resume last',
    d3: 'Models',
    d3p: 'Pick a platform model or paste your own key. A ping costs no credits.',
    d3a: 'Configure',
    d4: 'Credits',
    d4p: 'Balance, plans, pay, ledger, reconcile.',
    d4a: 'View',
    d5: 'Account',
    d5p: 'Verify email, change password, kick sessions.',
    d5a: 'Open',
    d6: 'Gitee repo',
    d6p: 'Source and release live here. The build script pulls from here too.',
    d6a: 'Open repo',
    nextKicker: 'Start',
    nextH2: 'Open a workspace. Ask the first thing.',
    nextLead: 'Tell the current file “explain this class”. Citations click. Edits come as cards.',
    enterWs: 'Enter workspaces',
    signup: 'Log in / sign up',
    logout: 'Log out',
    clone: 'Clone this product',
    copiedGitee: 'Copied Gitee',
    copyGitee: 'Copy Gitee',
    copiedGithub: 'Copied GitHub',
    copyGithub: 'Copy GitHub',
    foot: 'The model only emits patches. Writing disk is yours.',
    models: 'Models',
    day: 'Day',
    night: 'Night',
    madeKicker: 'Creator',
    creatorRole: 'Independent · Web Code Assistant',
    giteeLabel: 'Gitee repo',
    githubLabel: 'GitHub repo',
    cloneLabel: 'Clone URL',
  },
} as const;

const FLOW = [
  {
    id: 0,
    no: '01',
    screen: 'ask',
    zh: { title: '你提问', body: '对着当前文件说话。路径、选区、@引用会跟着进这一轮。' },
    en: { title: 'You ask', body: 'Talk to the current file. Path, selection, and @mentions ride along.' },
  },
  {
    id: 1,
    no: '02',
    screen: 'card',
    zh: { title: '它出补丁卡', body: '模型只能 propose_patch。卡片上是 diff、影响面、宪章，磁盘还没动。' },
    en: { title: 'It proposes a card', body: 'The model can only propose_patch. Diff, impact, constitution — disk has not moved.' },
  },
  {
    id: 2,
    no: '03',
    screen: 'live',
    zh: { title: '看着它改', body: '编辑器从原文一段段放到改后，顶上写着「预览 · 未写盘」。' },
    en: { title: 'Watch it change', body: 'The editor plays before → after. The banner says preview, not on disk.' },
  },
  {
    id: 3,
    no: '04',
    screen: 'apply',
    zh: { title: '你点应用', body: '唯一写盘入口。编译失败会把输出喂回去再改。' },
    en: { title: 'You apply', body: 'The only write. A compile miss is fed back for another turn.' },
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

function readLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'night' ? 'night' : 'day';
  } catch {
    return 'day';
  }
}

export function HomePage({ user, onLogout }: HomePageProps) {
  const [active, setActive] = useState('hero');
  const [play, setPlay] = useState(0);
  const [copied, setCopied] = useState<'gitee' | 'github' | null>(null);
  const [lang, setLang] = useState<Lang>(readLang);
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [langOpen, setLangOpen] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const holdRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const orbitRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);
  const desk = lastIdePath();
  const enter = user ? '/workspaces' : '/login';
  const t = I18N[lang];
  const creditTape = useMemo(() => {
    const items =
      lang === 'en'
        ? [CREATOR, 'Gitee', 'GitHub', 'HITL', 'propose_patch']
        : [CREATOR, 'Gitee 仓库', 'GitHub 仓库', '人在环上', 'propose_patch'];
    return [...items, ...items];
  }, [lang]);

  useEffect(() => {
    const nodes = ['hero', 'how', 'flow', 'doors', 'next']
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
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
  }, [lang]);

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

  useEffect(() => {
    try {
      localStorage.setItem(LANG_KEY, lang);
    } catch {
      /* ignore quota */
    }
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
  }, [lang]);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore quota */
    }
  }, [theme]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 20000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!langOpen) return;
    const close = (event: Event) => {
      if (!langRef.current?.contains(event.target as Node)) setLangOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [langOpen]);

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
    const orbit = orbitRef.current;
    if (orbit) {
      orbit.style.setProperty('--rx', '0deg');
      orbit.style.setProperty('--ry', '0deg');
    }
  };

  const onSpot = (event: PointerEvent<HTMLDivElement>) => {
    const root = rootRef.current;
    if (!root) return;
    root.style.setProperty('--spot-x', `${event.clientX}px`);
    root.style.setProperty('--spot-y', `${event.clientY}px`);
  };

  const onTilt = (event: MouseEvent<HTMLDivElement>) => {
    const orbit = orbitRef.current;
    if (!orbit) return;
    const box = orbit.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    orbit.style.setProperty('--rx', `${(-y * 8).toFixed(2)}deg`);
    orbit.style.setProperty('--ry', `${(x * 10).toFixed(2)}deg`);
  };

  const clock = now.toLocaleTimeString(lang === 'en' ? 'en-GB' : 'zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });

  const nav = [
    { id: 'how', label: t.navHow },
    { id: 'flow', label: t.navFlow },
    { id: 'doors', label: t.navDoors },
    { id: 'next', label: t.navNext },
  ];

  return (
    <div
      ref={rootRef}
      className="gate"
      data-theme={theme}
      data-lang={lang}
      onPointerMove={onSpot}
    >
      <div className="gate-spot" aria-hidden="true" />
      <div className="gate-orbs" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <header className="gate-nav">
        <button type="button" className="gate-brand" onClick={() => scrollTo('hero')}>
          <span className="gate-mark">
            <TerminalMark size={15} />
          </span>
          <span>
            <b>WCA</b>
            <i>{t.brandSub}</i>
          </span>
        </button>
        <nav className="gate-links" aria-label={lang === 'en' ? 'On this page' : '本页分节'}>
          {nav.map((item) => (
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
          <div className="gate-lang" ref={langRef}>
            <button
              type="button"
              className={`gate-lang-btn${langOpen ? ' on' : ''}`}
              aria-expanded={langOpen}
              aria-haspopup="listbox"
              aria-label={lang === 'en' ? 'Language' : '语言'}
              onClick={() => setLangOpen((open) => !open)}
            >
              <LangMark />
              <i className="gate-lang-caret" />
            </button>
            {langOpen && (
              <div className="gate-lang-menu" role="listbox">
                <button
                  type="button"
                  role="option"
                  aria-selected={lang === 'zh'}
                  className={lang === 'zh' ? 'on' : ''}
                  onClick={() => {
                    setLang('zh');
                    setLangOpen(false);
                  }}
                >
                  中文
                </button>
                <button
                  type="button"
                  role="option"
                  aria-selected={lang === 'en'}
                  className={lang === 'en' ? 'on' : ''}
                  onClick={() => {
                    setLang('en');
                    setLangOpen(false);
                  }}
                >
                  English
                </button>
              </div>
            )}
          </div>
          <span className="gate-nav-rule" aria-hidden="true" />
          <button
            type="button"
            className="gate-theme"
            aria-pressed={theme === 'night'}
            aria-label={theme === 'night' ? t.day : t.night}
            onClick={() => setTheme(theme === 'day' ? 'night' : 'day')}
          >
            <span className="gate-theme-knob">{theme === 'day' ? <SunMark /> : <MoonMark />}</span>
          </button>
          {user ? (
            <>
              <span className="gate-who">{user.username}</span>
              <a className="gate-ghost" href={appHref('/workspaces')} target="_blank" rel="noopener noreferrer">
                {t.workspaces}
              </a>
              <a className="gate-solid" href={appHref(desk ?? '/workspaces')} target="_blank" rel="noopener noreferrer">
                {t.enterIde}
              </a>
            </>
          ) : (
            <>
              <a className="gate-ghost" href={appHref('/login')} target="_blank" rel="noopener noreferrer">
                {t.login}
              </a>
              <a className="gate-solid" href={appHref('/login')} target="_blank" rel="noopener noreferrer">
                {t.start}
              </a>
            </>
          )}
        </div>
      </header>

      <section className="gate-hero" id="hero">
        <div className="gate-stars" aria-hidden="true">
          <i className="s1" />
          <i className="s2" />
          <i className="s3" />
          <b className="gate-meteor" />
          <b className="gate-meteor m2" />
        </div>
        <div className="gate-hero-inner">
          <div className="gate-hero-status" aria-hidden="true">
            <span>{t.heroMode}</span>
            <span>{t.heroCheck}</span>
          </div>
          <p className="gate-kicker">{t.kicker}</p>
          <h1>
            <span className="gate-line">{t.h1a}</span>
            <span className="gate-line">{t.h1b}</span>
          </h1>
          <div className="gate-pipe">
            <span className="gate-pipe-title">{t.pipeTitle}</span>
            <ol className="gate-pipe-nodes">
              {t.pipeNodes.map((node, index) => (
                <li
                  key={node.m}
                  className={index === 3 ? 'is-wait' : index === t.pipeNodes.length - 1 ? 'is-lock' : ''}
                >
                  <b>{node.m}</b>
                  <i>{node.s}</i>
                  {index === 3 && <em className="gate-pipe-wait">{t.pipeWait}</em>}
                </li>
              ))}
            </ol>
          </div>
          <p className="gate-lead">{t.lead}</p>
          <div className="gate-hero-cta">
            <a className="gate-solid gate-lg" href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              {user ? t.openWs : t.loginStart}
            </a>
            <button type="button" className="gate-ghost gate-lg" onClick={() => scrollTo('flow')}>
              {t.seeLoop}
            </button>
          </div>
          <div className="gate-hero-ticker" aria-hidden="true">
            {t.tape.join(' // ')}
          </div>
        </div>
      </section>

      <section className="gate-band gate-reveal" id="how">
        <div className="gate-band-head">
          <p className="gate-kicker">{t.howKicker}</p>
          <h2 className="gate-title">{t.howH2}</h2>
          <p>{t.howLead}</p>
        </div>
        <div className="gate-spine">
          <article>
            <header className="gate-spine-meta">
              <em>01</em>
              <span>{t.evid}</span>
            </header>
            <div className="gate-spine-copy">
              <h3>{t.evidH}</h3>
              <p>{t.evidP}</p>
            </div>
            <a className="gate-spine-go" href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              {t.evidA}
            </a>
          </article>
          <article>
            <header className="gate-spine-meta">
              <em>02</em>
              <span>{t.review}</span>
            </header>
            <div className="gate-spine-copy">
              <h3>{t.reviewH}</h3>
              <p>{t.reviewP}</p>
            </div>
            <a className="gate-spine-go" href={appHref(user ? '/workspaces' : '/login')} target="_blank" rel="noopener noreferrer">
              {t.reviewA}
            </a>
          </article>
          <article>
            <header className="gate-spine-meta">
              <em>03</em>
              <span>{t.write}</span>
            </header>
            <div className="gate-spine-copy">
              <h3>{t.writeH}</h3>
              <p>{t.writeP}</p>
            </div>
            <button type="button" className="gate-spine-go" onClick={() => scrollTo('flow')}>
              {t.writeA}
            </button>
          </article>
        </div>
      </section>

      <section className="gate-embed gate-reveal">
        <div>
          <p className="gate-kicker">{t.embedKicker}</p>
          <h2 className="gate-title">{t.embedH2}</h2>
          <ol>
            <li>
              <em>01</em>
              <div>
                <b>{t.tree}</b>
                <p>{t.treeP}</p>
              </div>
            </li>
            <li>
              <em>02</em>
              <div>
                <b>{t.ed}</b>
                <p>{t.edP}</p>
              </div>
            </li>
            <li>
              <em>03</em>
              <div>
                <b>{t.talk}</b>
                <p>{t.talkP}</p>
              </div>
            </li>
          </ol>
        </div>
        <div className="gate-code">
          <header>
            <span>HITL · propose_patch</span>
            <a href={appHref(enter)} target="_blank" rel="noopener noreferrer">
              {t.tryOnce}
            </a>
          </header>
          <ul className="gate-hitl">
            <li>
              <b>{t.hitlModel}</b>
              <span>{t.hitlModelP}</span>
            </li>
            <li>
              <b>{t.hitlYou}</b>
              <span>{t.hitlYouP}</span>
            </li>
            <li>
              <b>{t.hitlDisk}</b>
              <span>{t.hitlDiskP}</span>
            </li>
          </ul>
        </div>
        <div
          ref={orbitRef}
          className="gate-desk-orbit"
          onMouseMove={onTilt}
          onMouseEnter={pauseLoop}
          onMouseLeave={resumeLoop}
        >
          <span className="gate-live-pill">
            <i />
            {FLOW[play][lang].title}
          </span>
          <div className={`gate-desk is-beat-${play}`}>
            <div className="gate-desk-bar">
              <i />
              <i />
              <i />
              <em>demo-java / UserService.java</em>
              <small>
                {FLOW[play][lang].title} · {clock}
              </small>
              <b className="gate-desk-progress" style={{ width: `${((play + 1) / FLOW.length) * 100}%` }} />
            </div>
            <div className="gate-desk-body">
              <aside className="gate-pane gate-pane-tree">
                <header>{t.files}</header>
                <ul>
                  <li>src</li>
                  <li className="on nest">UserService.java</li>
                  <li className="nest">UserRepository.java</li>
                  <li>pom.xml</li>
                </ul>
              </aside>
              <div className="gate-pane gate-pane-code">
                <header>{play >= 2 ? t.preview : t.editor}</header>
                <div className="gate-code-stack">
                  <pre className="is-before">{BEFORE}</pre>
                  <pre className="is-after">{AFTER}</pre>
                  <span className="gate-scan" />
                </div>
              </div>
              <aside className="gate-pane gate-pane-chat">
                <header>{t.chat}</header>
                <div className={`gate-bubble${play === 0 ? ' is-typing' : ''}`}>
                  {t.bubble}
                  {play === 0 && <i className="gate-caret" />}
                </div>
                <div className="gate-patch">
                  <b>{t.patch}</b>
                  <code>+ private final UserRepository repo;</code>
                  <small>{t.impact}</small>
                  <a href={appHref(enter)} target="_blank" rel="noopener noreferrer">
                    {t.apply}
                  </a>
                </div>
                <div className="gate-done">{t.applied}</div>
              </aside>
            </div>
          </div>
        </div>
        <ol className="gate-beats">
          {FLOW.map((item) => (
            <li key={item.id}>
              <button type="button" className={play === item.id ? 'on' : ''} onClick={() => pick(item.id)}>
                <em>{item.no}</em>
                {item[lang].title}
              </button>
            </li>
          ))}
        </ol>
      </section>

      <section className="gate-flow gate-reveal" id="flow">
        <div className="gate-band-head">
          <p className="gate-kicker">{t.flowKicker}</p>
          <h2 className="gate-title">{t.flowH2}</h2>
          <p>{t.flowLead}</p>
        </div>
        <div className="gate-flow-grid">
          <ol>
            {FLOW.map((item) => (
              <li key={item.id}>
                <button type="button" className={play === item.id ? 'on' : ''} onClick={() => pick(item.id)}>
                  <em>{item.no}</em>
                  <span>
                    <b>{item[lang].title}</b>
                    {item[lang].body}
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <div className={`gate-stage stage-${FLOW[play].screen}`} key={`${play}-${lang}`}>
            <div className="gate-stage-bar">
              <i />
              <i />
              <i />
              <em>
                {FLOW[play].no} / {FLOW[play][lang].title}
              </em>
            </div>
            <div className="gate-stage-body">
              {play === 0 && (
                <div className="gate-stage-ask">
                  <span>{t.you}</span>
                  <p>{t.bubble}</p>
                </div>
              )}
              {play === 1 && (
                <div className="gate-stage-card">
                  <b>{t.patch}</b>
                  <code>+ private final UserRepository repo;</code>
                  <small>{t.impact}</small>
                </div>
              )}
              {play === 2 && (
                <div className="gate-stage-live">
                  <i /> {t.live}
                  <pre>{`  public UserService(UserRepository repo) {\n      this.repo = repo;\n  }`}</pre>
                </div>
              )}
              {play === 3 && (
                <div className="gate-stage-apply">
                  <p>{t.compiling}</p>
                  <a className="gate-solid" href={appHref(enter)} target="_blank" rel="noopener noreferrer">
                    {t.realIde}
                  </a>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="gate-doors gate-reveal" id="doors">
        <div className="gate-band-head">
          <p className="gate-kicker">{t.doorsKicker}</p>
          <h2 className="gate-title">{t.doorsH2}</h2>
        </div>
        <div className="gate-door-list">
          <a href={appHref(user ? '/workspaces' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>
              <i>01</i>
              {t.d1}
            </em>
            <p>{t.d1p}</p>
            <span>{t.d1a}</span>
          </a>
          <a href={appHref(desk ?? enter)} target="_blank" rel="noopener noreferrer">
            <em>
              <i>02</i>
              {t.d2}
            </em>
            <p>{t.d2p}</p>
            <span>{desk ? t.d2b : t.d2a}</span>
          </a>
          <a href={appHref(user ? '/models' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>
              <i>03</i>
              {t.d3}
            </em>
            <p>{t.d3p}</p>
            <span>{t.d3a}</span>
          </a>
          <a href={appHref(user ? '/credits' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>
              <i>04</i>
              {t.d4}
            </em>
            <p>{t.d4p}</p>
            <span>{t.d4a}</span>
          </a>
          <a href={appHref(user ? '/account' : '/login')} target="_blank" rel="noopener noreferrer">
            <em>
              <i>05</i>
              {t.d5}
            </em>
            <p>{t.d5p}</p>
            <span>{t.d5a}</span>
          </a>
          <a href="https://gitee.com/du-jiangjiang/web-code-assistant" target="_blank" rel="noopener noreferrer">
            <em>
              <i>06</i>
              {t.d6}
            </em>
            <p>{t.d6p}</p>
            <span>{t.d6a}</span>
          </a>
        </div>
      </section>

      <section className="gate-next" id="next">
        <div className="gate-next-grid">
          <div className="gate-next-copy">
            <p className="gate-kicker">{t.nextKicker}</p>
            <h2 className="gate-title">{t.nextH2}</h2>
            <p>{t.nextLead}</p>
            <div className="gate-hero-cta">
              <a className="gate-solid gate-lg" href={appHref(enter)} target="_blank" rel="noopener noreferrer">
                {user ? t.enterWs : t.signup}
              </a>
              {user && (
                <button type="button" className="gate-ghost gate-lg" onClick={onLogout}>
                  {t.logout}
                </button>
              )}
            </div>
          </div>
          <div className="gate-clone">
            <header>{t.clone}</header>
            <code>{GITEE}</code>
            <div className="gate-clone-actions">
              <button type="button" onClick={() => void copy('gitee')}>
                {copied === 'gitee' ? t.copiedGitee : t.copyGitee}
              </button>
              <button type="button" onClick={() => void copy('github')}>
                {copied === 'github' ? t.copiedGithub : t.copyGithub}
              </button>
              <a href="https://github.com/Dujiang777/WebCodeAssistant" target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
            </div>
          </div>
        </div>
      </section>

      <div className="gate-tape gate-tape-end" aria-hidden="true">
        <div className="gate-tape-track">
          {creditTape.map((item, index) => (
            <span key={`${item}-${index}`}>{item}</span>
          ))}
        </div>
      </div>

      <section className="gate-colophon" id="made">
        <p className="gate-kicker">{t.madeKicker}</p>
        <h2 className="gate-creator">{CREATOR}</h2>
        <p className="gate-creator-role">{t.creatorRole}</p>
        <ul className="gate-repos">
          <li>
            <span>{t.giteeLabel}</span>
            <a href={GITEE_PAGE} target="_blank" rel="noopener noreferrer">
              gitee.com/du-jiangjiang/web-code-assistant
            </a>
          </li>
          <li>
            <span>{t.githubLabel}</span>
            <a href={GITHUB_PAGE} target="_blank" rel="noopener noreferrer">
              github.com/Dujiang777/WebCodeAssistant
            </a>
          </li>
          <li>
            <span>{t.cloneLabel}</span>
            <code>{GITEE}</code>
          </li>
        </ul>
      </section>

      <footer className="gate-foot">
        <span className="gate-mark">
          <TerminalMark size={15} />
        </span>
        <div>
          <b>Web Code Assistant</b>
          <p>{t.foot}</p>
        </div>
        <div className="gate-foot-links">
          <a href={appHref('/login')} target="_blank" rel="noopener noreferrer">
            {t.login}
          </a>
          <a href={appHref('/workspaces')} target="_blank" rel="noopener noreferrer">
            {t.workspaces}
          </a>
          <a href={appHref('/models')} target="_blank" rel="noopener noreferrer">
            {t.models}
          </a>
        </div>
      </footer>
    </div>
  );
}

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function LangMark() {
  return (
    <svg className="gate-lang-mark" width="22" height="18" viewBox="0 0 22 18" aria-hidden="true">
      <text x="0" y="14" fontSize="13" fontWeight="700" fill="currentColor">
        文
      </text>
      <text x="12" y="15" fontSize="12" fontWeight="700" fill="currentColor">
        A
      </text>
    </svg>
  );
}

function SunMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.4" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MoonMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M10.2 2.2A5.6 5.6 0 105.2 13a4.6 4.6 0 105-10.8z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 同一站点的 hash 路由，新标签打开，首页自己留着。 */
function appHref(path: string): string {
  const url = new URL(window.location.href);
  url.hash = `#${path.startsWith('/') ? path : `/${path}`}`;
  return url.toString();
}
