import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { adoptAuth, api } from '../lib/api';
import { HttpError } from '../lib/api';
import type { AuthResult, AuthUser, CaptchaChallenge, Dispatch } from '../lib/api';
import { messageOf } from '../lib/chat';
import { RefreshIcon, TerminalMark } from '../components/icons';
import { TypingTerminal } from '../components/TypingTerminal';

/**
 * 登录 / 注册 / 忘记密码。
 *
 * 两栏而不是一个居中的小表单：左边解释「这个工具到底做什么」，
 * 右边才是操作区。理由很实际 —— 这类工具最大的门槛不是密码，
 * 而是用户不知道它能干什么、以及自己的代码放在哪。
 *
 * 四种模式共用一个组件而不是拆成四个路由，是因为它们共享同一份状态机：
 * 输了一半的邮箱要能带到下一步（注册完去验证、找回密码填过的地址不重填），
 * 拆开就得靠 URL 参数来回传，反而更容易丢。
 *
 * 两处刻意的设计：
 *   - 注册后不直接把用户丢进工作台，而是停一步让他**当场验证邮箱** ——
 *     这一步跳过去，以后找回密码、收通知就全靠运气了；
 *   - 「一键随机演示账号」是唯一会跳过验证的入口（它本来就是临时账号），
 *     保证任何人在 3 秒内能看到产品本体，而不是先过一道注册表单。
 */
interface LoginPageProps {
  onAuthenticated: (user: AuthUser) => void;
}

type Mode = 'login' | 'register' | 'forgot' | 'verify';

/** 与后端 AuthService.validatePassword 一一对应 —— 前端先拦一道，避免白跑一次请求。 */
const PASSWORD_RULES: { test: (value: string) => boolean; label: string }[] = [
  { test: (value) => value.length >= 8, label: '至少 8 位' },
  { test: (value) => /[A-Za-z]/.test(value), label: '包含字母' },
  { test: (value) => /\d/.test(value), label: '包含数字' },
];

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotEmail, setForgotEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 非致命的提示（例如「邮件已发出」），与 error 分开显示，颜色也不同。 */
  const [notice, setNotice] = useState<string | null>(null);
  /** 注册成功后待验证的邮箱与新账号（用于「立即验证」与「直接进入」两条出口）。 */
  const [pending, setPending] = useState<{ result: AuthResult; email: string; devToken: string | null } | null>(
    null,
  );
  /** 找回密码的结果：dev 模式下会带回重置令牌，本地能直接跳过去。 */
  const [resetInfo, setResetInfo] = useState<Dispatch | null>(null);
  /** 图形验证码：注册 / 找回 / 演示账号都要过这一关。null 表示还没拉到或后端未启用。 */
  const [captcha, setCaptcha] = useState<CaptchaChallenge | null>(null);
  const [captchaCode, setCaptchaCode] = useState('');
  /** 演示账号在无 devAnswer 的生产模式下，先在登录页内联过一道验证码。 */
  const [awaitingDemoCaptcha, setAwaitingDemoCaptcha] = useState(false);
  /** 撞库防线：同 IP 多账号连败后，后端要求登录也带验证码（CAPTCHA_INVALID 触发）。 */
  const [loginCaptchaRequired, setLoginCaptchaRequired] = useState(false);

  /** 拉一张新验证码。失败不阻断表单（后端关了验证码时 /captcha 返回空 id）。 */
  const loadCaptcha = async () => {
    try {
      const challenge = await api.captcha();
      setCaptcha(challenge.id ? challenge : null);
      setCaptchaCode('');
    } catch {
      setCaptcha(null);
    }
  };

  // dev 部署下答案随验证码回显：加载成功后回填一次（生产下 devAnswer 为 null，用户手输）
  useEffect(() => {
    if (captcha?.devAnswer) {
      setCaptchaCode(captcha.devAnswer);
    }
  }, [captcha]);

  // 注册 / 找回模式挂载验证码；模式切换重置输入，防止上一张图的答案被带过去
  useEffect(() => {
    if (mode === 'register' || mode === 'forgot') {
      void loadCaptcha();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /** 验证码是一次性的：提交失败后必须换新的一张。 */
  const refreshCaptchaAfterFailure = () => {
    if (mode === 'register' || mode === 'forgot' || awaitingDemoCaptcha || loginCaptchaRequired) {
      void loadCaptcha();
    }
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setNotice(null);
    setResetInfo(null);
  };

  /**
   * 注册。`autoEnter=false` 时**刻意先不落会话**。
   *
   * 为什么：`adoptAuth` 会把登录态广播出去，App 一收到就立刻把登录页换掉 ——
   * 那样「验证邮箱」这一步会被瞬间跳过，用户根本看不到它。
   * 所以注册表单这条路先把令牌攥在手里，等用户点了「立即验证」或「先去工作台」再落盘；
   * 一键演示账号（autoEnter=true）本来就是要立刻进产品，直接落。
   */
  const registerLocal = async (name: string, address: string, pass: string, autoEnter: boolean) => {
    // dev 部署下答案直接回显（见 api.ts 注释），演示账号才能全自动；
    // 生产下演示账号走 awaitingDemoCaptcha 的内联验证码，人工输入。
    const solved =
      captcha && captchaCode.trim().length > 0
        ? { id: captcha.id, code: captchaCode.trim() }
        : captcha?.devAnswer
          ? { id: captcha.id, code: captcha.devAnswer }
          : undefined;
    const result = await api.register(name, address, pass, solved);
    if (autoEnter) {
      onAuthenticated(adoptAuth(result));
      return;
    }
    setPending({ result, email: result.email ?? address, devToken: result.devVerifyToken });
    setMode('verify');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (mode === 'login') {
        const solved =
          loginCaptchaRequired && captcha && captchaCode.trim().length > 0
            ? { id: captcha.id, code: captchaCode.trim() }
            : undefined;
        const result = await api.login(username.trim(), password, solved);
        onAuthenticated(adoptAuth(result));
      } else if (mode === 'register') {
        await registerLocal(username.trim(), email.trim(), password, false);
      } else if (mode === 'forgot') {
        const solved =
          captcha && captchaCode.trim().length > 0 ? { id: captcha.id, code: captchaCode.trim() } : undefined;
        const dispatch = await api.forgotPassword(forgotEmail.trim(), solved);
        setResetInfo(dispatch);
        setNotice(
          dispatch.sent
            ? `若 ${forgotEmail.trim()} 已注册，我们已发出重置邮件。请查收（含垃圾邮件箱）。`
            : '邮件发送失败，请稍后重试。',
        );
      }
    } catch (err) {
      // 撞库防线：后端要求登录验证码 → 弹出验证码框，用户填完原样重试即可
      if (err instanceof HttpError && err.code === 'CAPTCHA_INVALID' && mode === 'login' && !loginCaptchaRequired) {
        setLoginCaptchaRequired(true);
        void loadCaptcha();
      }
      setError(messageOf(err));
      refreshCaptchaAfterFailure();
    } finally {
      setBusy(false);
    }
  };

  const createDemoAccount = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const suffix = Math.random().toString(36).slice(2, 6);
    const demoUser = `demo_${suffix}`;
    try {
      await registerLocal(demoUser, `${demoUser}@example.com`, 'demo1234', true);
    } catch (err) {
      setError(messageOf(err));
      // devAnswer 自动解题失败（例如答案过期）：转为人工内联验证码
      if (!awaitingDemoCaptcha) {
        setAwaitingDemoCaptcha(true);
        void loadCaptcha();
      }
      setBusy(false);
    }
  };

  const verifyNow = async () => {
    if (!pending?.devToken) return;
    setBusy(true);
    setError(null);
    try {
      await api.verifyEmail(pending.devToken);
      onAuthenticated(adoptAuth({ ...pending.result, emailVerified: true }));
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  };

  const ready =
    mode === 'login'
      ? awaitingDemoCaptcha || loginCaptchaRequired
        ? username.trim().length >= 3 && captchaCode.trim().length > 0
        : username.trim().length > 0 && password.length > 0
      : mode === 'register'
        ? username.trim().length >= 3 &&
          EMAIL_PATTERN.test(email.trim()) &&
          PASSWORD_RULES.every((r) => r.test(password)) &&
          (!captcha || captchaCode.trim().length > 0 || captcha.devAnswer !== null)
        : EMAIL_PATTERN.test(forgotEmail.trim()) && (!captcha || captchaCode.trim().length > 0);

  const title = { login: '登录', register: '创建账号', forgot: '找回密码', verify: '验证邮箱' }[mode];

  return (
    <div className="auth-wrap auth-wrap-v2">
      <section className="auth-hero">
        <div className="brand" style={{ borderRight: 'none', paddingRight: 0 }}>
          <TerminalMark size={30} className="brand-mark" />
          <div className="brand-text">
            <span className="brand-name" style={{ fontSize: 14 }}>
              WEB CODE ASSISTANT
            </span>
            <span className="brand-sub">网页版编码助手</span>
          </div>
        </div>

        <h1 className="auth-title">
          把仓库放进浏览器，
          <br />
          让 AI 读懂它再动手。
        </h1>

        <p className="auth-lead">
          左边是文件树，中间是真编辑器，右边是能读代码、能搜代码的 AI。
          它改代码的方式只有一种：给你一份 diff，你点确认它才写盘。
        </p>

        <TypingTerminal />

        <ul className="auth-features">
          <li>
            <b>代码在你的服务器上</b>
            <span>工作区是服务端磁盘上的真实目录（git clone 或 zip 导入），不是浏览器里的虚拟文件系统。</span>
          </li>
          <li>
            <b>每个结论都挂证据</b>
            <span>回答里的「文件:行号」可以点，点一下编辑器跳过去并高亮那一行；找不到的就明说没找到。</span>
          </li>
          <li>
            <b>应用之前先看影响面</b>
            <span>补丁还没应用就会告诉你：改了谁、谁在调用、有没有测试覆盖、风险多高；应用后自动编译验证。</span>
          </li>
          <li>
            <b>用多少算多少</b>
            <span>积分按真实 token 用量结算：先用预扣额度、回合结束多退少补，每一笔都留在可对账的账本里。</span>
          </li>
        </ul>
      </section>

      <section className="auth-form-wrap">
        <div className="card">
          <div className="card-head">
            <TerminalMark size={20} />
            <span className="card-title">{title}</span>
          </div>

          <p className="card-desc">
            {mode === 'login' && '用用户名或邮箱登录。连续输错 5 次会锁定账号 15 分钟。'}
            {mode === 'register' &&
              '用户名 3–64 位（字母、数字、下划线、点、短横线）；密码 8–128 位且需同时含字母与数字。'}
            {mode === 'forgot' && '填注册时用的邮箱，我们会发一封重置邮件。出于安全考虑，无论该邮箱是否已注册都会显示发送成功。'}
            {mode === 'verify' && '账号已创建。验证邮箱后才能真正用上找回密码与安全通知。'}
          </p>

          {mode === 'verify' && pending ? (
            <div className="form-stack">
              <div className="verify-panel">
                <span className="dot dot-warn" />
                <div>
                  <div className="verify-title">验证邮件已发送至 {pending.email}</div>
                  <p className="verify-sub">
                    {pending.devToken
                      ? '当前是本地开发邮件通道（不发真实邮件），点击下方按钮可直接完成验证。'
                      : '请到邮箱里点开验证链接。如果没收到，可以稍后在「账号与安全」里重新发送。'}
                  </p>
                </div>
              </div>

              {pending.devToken && (
                <button className="btn btn-primary" type="button" onClick={() => void verifyNow()} disabled={busy}>
                  {busy && <span className="spinner" />}
                  本地开发模式：立即完成验证
                </button>
              )}

              <button
                className={pending.devToken ? 'btn' : 'btn btn-primary'}
                type="button"
                onClick={() => onAuthenticated(adoptAuth(pending.result))}
                disabled={busy}
              >
                先去工作台，稍后再验证
              </button>

              {error && <div className="form-error">{error}</div>}
            </div>
          ) : (
            <form className="form-stack" onSubmit={submit}>
              {mode === 'login' && (
                <div className="field">
                  <label htmlFor="username">用户名或邮箱</label>
                  <input
                    id="username"
                    className="input"
                    autoComplete="username"
                    autoFocus
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="例如 dev_yuan 或 dev@example.com"
                  />
                </div>
              )}

              {mode === 'register' && (
                <>
                  <div className="field">
                    <label htmlFor="username">用户名</label>
                    <input
                      id="username"
                      className="input"
                      autoComplete="username"
                      autoFocus
                      value={username}
                      onChange={(event) => setUsername(event.target.value)}
                      placeholder="例如 dev_yuan"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="email">邮箱</label>
                    <input
                      id="email"
                      className="input"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="用于找回密码与安全通知"
                    />
                  </div>
                </>
              )}

              {mode === 'forgot' && (
                <div className="field">
                  <label htmlFor="forgot-email">注册邮箱</label>
                  <input
                    id="forgot-email"
                    className="input"
                    type="email"
                    autoComplete="email"
                    autoFocus
                    value={forgotEmail}
                    onChange={(event) => setForgotEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                </div>
              )}

              {(mode === 'register' || mode === 'forgot' || awaitingDemoCaptcha ||
                (mode === 'login' && loginCaptchaRequired)) && captcha && (
                <div className="field">
                  <label htmlFor="captcha-code">图形验证码</label>
                  <div className="captcha-row">
                    <img
                      className="captcha-img"
                      src={`data:image/png;base64,${captcha.imagePngBase64}`}
                      alt="图形验证码，看不清可点击刷新"
                      title="看不清？点击换一张"
                      onClick={() => void loadCaptcha()}
                    />
                    <input
                      id="captcha-code"
                      className="input captcha-input"
                      maxLength={16}
                      autoComplete="off"
                      value={captchaCode}
                      onChange={(event) => setCaptchaCode(event.target.value)}
                      placeholder="输入图中的字符"
                    />
                    <button
                      className="btn btn-sm"
                      type="button"
                      onClick={() => void loadCaptcha()}
                      title="换一张"
                      aria-label="换一张验证码"
                    >
                      <RefreshIcon size={13} />
                    </button>
                  </div>
                  {awaitingDemoCaptcha && (
                    <span className="field-hint">创建演示账号也需要通过验证码（防脚本刷号）。</span>
                  )}
                  {mode === 'login' && loginCaptchaRequired && (
                    <span className="field-hint">
                      你的网络最近有多个账号连续登录失败，需要验证码确认是真人（防撞库攻击）。
                    </span>
                  )}
                </div>
              )}

              {(mode === 'login' || mode === 'register') && (
                <div className="field">
                  <label htmlFor="password">密码</label>
                  <input
                    id="password"
                    className="input"
                    type="password"
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder={mode === 'login' ? '输入密码' : '至少 8 位，含字母与数字'}
                  />
                </div>
              )}

              {mode === 'register' && (
                <ul className="pw-rules">
                  {PASSWORD_RULES.map((rule) => {
                    const passed = rule.test(password);
                    return (
                      <li key={rule.label} className={passed ? 'on' : ''}>
                        <span className={`dot ${passed ? 'dot-ok' : ''}`} />
                        {rule.label}
                      </li>
                    );
                  })}
                </ul>
              )}

              {error && <div className="form-error">{error}</div>}
              {notice && <div className="form-notice">{notice}</div>}

              {mode === 'forgot' && resetInfo?.devToken && (
                <button
                  className="btn"
                  type="button"
                  onClick={() => {
                    window.location.hash = `#/reset-password?token=${resetInfo.devToken}`;
                  }}
                >
                  本地开发模式：直接打开重置链接
                </button>
              )}

              <button className="btn btn-primary" type="submit" disabled={busy || !ready}>
                {busy && <span className="spinner" />}
                {mode === 'login' ? '登录' : mode === 'register' ? '注册' : '发送重置邮件'}
              </button>

              {mode === 'login' && (
                <button className="btn" type="button" onClick={() => void createDemoAccount()} disabled={busy}>
                  一键随机演示账号
                </button>
              )}
            </form>
          )}

          <div className="switch-line">
            {mode === 'login' && (
              <>
                <button className="link" onClick={() => switchMode('forgot')}>
                  忘记密码？
                </button>
                <span className="switch-sep" />
                <span>还没有账号？</span>
                <button className="link" onClick={() => switchMode('register')}>
                  创建账号
                </button>
              </>
            )}
            {mode === 'register' && (
              <>
                <span>已经有账号了？</span>
                <button className="link" onClick={() => switchMode('login')}>
                  去登录
                </button>
              </>
            )}
            {mode === 'forgot' && (
              <>
                <span>想起来了？</span>
                <button className="link" onClick={() => switchMode('login')}>
                  返回登录
                </button>
              </>
            )}
            {mode === 'verify' && (
              <>
                <span>账号已经能用了。</span>
                <button className="link" onClick={() => switchMode('login')}>
                  换个账号登录
                </button>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
