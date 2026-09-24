import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { api } from '../lib/api';
import { messageOf } from '../lib/chat';
import { TerminalMark } from '../components/icons';

/**
 * 邮件链接的两个落点：验证邮箱 / 重置密码。
 *
 * 为什么单独成页而不是塞进登录页的某个模式：这两个页面是**从邮件点进来的**，
 * 打开它们的浏览器往往没有登录态（手机上收邮件、在电脑上注册是常态），
 * 所以它们必须能在未登录状态下渲染。放进登录页会让「未登录 → 跳登录页」
 * 那条守卫逻辑把它们一起吞掉。
 *
 * 验证邮箱是「打开即执行」：链接点开就已经表达了意图，再让用户点一次
 * 「确认验证」纯属多余动作。但令牌只能用一次，所以必须防住 React 严格模式下的
 * 双次挂载 —— 用 ref 锁住，否则第二次调用会撞上「令牌已被消费」直接报错。
 */

const SHELL_TITLE = 'WEB CODE ASSISTANT';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="centered-page">
      <div className="card">
        <div className="card-head">
          <TerminalMark size={20} />
          <span className="card-title">{title}</span>
        </div>
        <div className="brand-text" style={{ marginBottom: 10 }}>
          <span className="brand-sub">{SHELL_TITLE}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function VerifyEmailPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [status, setStatus] = useState<'busy' | 'ok' | 'error'>(token ? 'busy' : 'error');
  const [message, setMessage] = useState(
    token ? '正在验证…' : '链接不完整：缺少验证令牌。请回到邮件里重新点开链接，或登录后在「账号与安全」里重新发送。',
  );
  const launched = useRef(false);

  useEffect(() => {
    if (!token || launched.current) return;
    launched.current = true;
    void (async () => {
      try {
        await api.verifyEmail(token);
        setStatus('ok');
        setMessage('邮箱验证成功。以后可以用这个邮箱找回密码、接收安全通知。');
      } catch (err) {
        setStatus('error');
        setMessage(messageOf(err));
      }
    })();
  }, [token]);

  return (
    <Shell title="验证邮箱">
      <div className={`auth-result ${status}`}>
        <span className={`dot ${status === 'busy' ? 'dot-warn' : status === 'ok' ? 'dot-ok' : 'dot-err'}`} />
        <span>{message}</span>
      </div>
      <div className="row">
        <button className="btn btn-primary" onClick={onDone} disabled={status === 'busy'}>
          {status === 'ok' ? '进入工作台' : '返回'}
        </button>
      </div>
    </Shell>
  );
}

export function ResetPasswordPage({ token, onDone }: { token: string; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <Shell title="重置密码">
        <div className="auth-result error">
          <span className="dot dot-err" />
          <span>链接不完整：缺少重置令牌。请回到邮件里重新点开链接。</span>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={onDone}>
            返回登录
          </button>
        </div>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell title="重置密码">
        <div className="auth-result ok">
          <span className="dot dot-ok" />
          <span>
            密码已重置，其他设备上的登录态已一并作废。请用新密码重新登录。
          </span>
        </div>
        <div className="row">
          <button className="btn btn-primary" onClick={onDone}>
            去登录
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell title="重置密码">
      <p className="card-desc">
        设置一个新密码。重置成功之后，之前所有设备上的登录都会被注销 —— 这正是「密码泄露了，
        改完就没事了」应该成立的含义。
      </p>
      <form className="form-stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="new-password">新密码</label>
          <input
            id="new-password"
            className="input"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="至少 8 位，含字母与数字"
          />
        </div>
        <div className="field">
          <label htmlFor="confirm-password">确认新密码</label>
          <input
            id="confirm-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="再输一次"
          />
        </div>
        {error && <div className="form-error">{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={busy || password.length === 0 || confirm.length === 0}>
          {busy && <span className="spinner" />}
          重置密码
        </button>
      </form>
    </Shell>
  );
}
