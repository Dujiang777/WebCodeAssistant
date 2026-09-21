import { useState } from 'react';
import type { FormEvent } from 'react';

import { api, saveSession } from '../lib/api';
import type { AuthUser } from '../lib/api';
import { messageOf } from '../lib/chat';
import { TerminalMark } from '../components/icons';

/**
 * 登录 / 注册。
 *
 * 两栏而不是一个居中的小表单：左边解释「这个工具到底做什么」，
 * 右边才是操作区。理由很实际 —— 这类工具最大的门槛不是密码，
 * 而是用户不知道它能干什么、以及自己的代码放在哪。
 */
interface LoginPageProps {
  onAuthenticated: (user: AuthUser) => void;
}

export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response =
        mode === 'login'
          ? await api.login(username.trim(), password)
          : await api.register(username.trim(), password);
      const user: AuthUser = { userId: response.userId, username: response.username };
      saveSession(response.token, user);
      onAuthenticated(user);
    } catch (err) {
      setError(messageOf(err));
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
    const demoPass = 'demo1234';
    try {
      const response = await api.register(demoUser, demoPass);
      saveSession(response.token, { userId: response.userId, username: response.username });
      onAuthenticated({ userId: response.userId, username: response.username });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
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
        </ul>
      </section>

      <section className="auth-form-wrap">
        <div className="card">
          <div className="card-head">
            <TerminalMark size={20} />
            <span className="card-title">{mode === 'login' ? '登录' : '创建账号'}</span>
          </div>

          <p className="card-desc">
            {mode === 'login'
              ? '用你的账号继续。若还没有账号，切到「创建账号」。'
              : '用户名 3–64 位，支持字母、数字、下划线、点和短横线；密码至少 6 位。'}
          </p>

          <form className="form-stack" onSubmit={submit}>
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
              <label htmlFor="password">密码</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder={mode === 'login' ? '输入密码' : '至少 6 位'}
              />
            </div>

            {error && <div className="form-error">{error}</div>}

            <button
              className="btn btn-primary"
              type="submit"
              disabled={busy || username.trim().length === 0 || password.length === 0}
            >
              {busy && <span className="spinner" />}
              {mode === 'login' ? '登录' : '注册并进入'}
            </button>

            <button className="btn" type="button" onClick={createDemoAccount} disabled={busy}>
              一键随机演示账号
            </button>
          </form>

          <div className="switch-line">
            <span>{mode === 'login' ? '还没有账号？' : '已经有账号了？'}</span>
            <button
              className="link"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
            >
              {mode === 'login' ? '创建账号' : '去登录'}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
