import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';

import { adoptAuth, api, formatDateTime, loadUser, subscribeSession } from '../lib/api';
import type { AuthUser, Dispatch, LoginSession, MeInfo } from '../lib/api';
import { messageOf } from '../lib/chat';
import { PageBar } from '../components/PageBar';
import { DeviceIcon, KeyIcon, TerminalMark } from '../components/icons';

/**
 * 账号与安全：身份信息、改密码、登录设备。
 *
 * 三件事都是「出了事才想起来要有的功能」，所以三件事都必须能自助完成、不需要联系客服：
 *   - 邮箱没验证 → 这里能重发（带 60 秒冷却，冷却期由服务端判，前端不复制这个规则）；
 *   - 想改密码 → 这里能改，改完其他设备立刻掉线，当前设备继续用；
 *   - 怀疑有别人登着 → 这里能看到设备/IP/登录时间，随手踢掉。
 *
 * 第三点是 refresh token 落库换来的直接收益：只存 JWT 的系统**做不出这个列表**，
 * 因为「有哪些会话在有效期内」这件事根本无处可查。
 */
export function AccountPage({ onBack, onLogout }: { onBack: () => void; onLogout: () => void }) {
  const [user, setUser] = useState<AuthUser | null>(() => loadUser());
  const [me, setMe] = useState<MeInfo | null>(null);
  const [sessions, setSessions] = useState<LoginSession[]>([]);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** dev 邮件通道下拿到的验证令牌：本地能一键走完验证，不用去翻日志。 */
  const [devToken, setDevToken] = useState<string | null>(null);

  useEffect(() => subscribeSession(setUser), []);

  const loadMe = async () => {
    try {
      setMe(await api.me());
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const loadSessions = async () => {
    try {
      setSessions(await api.loginSessions());
    } catch {
      // 设备列表属于诊断信息，拉不到不该让整页报错
    }
  };

  useEffect(() => {
    void loadMe();
    void loadSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (newPassword !== confirm) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      // 改密成功会返回**新的一对令牌**：其他设备被吊销，当前设备无缝继续
      adoptAuth(await api.changePassword(oldPassword, newPassword));
      setOldPassword('');
      setNewPassword('');
      setConfirm('');
      setNotice('密码已修改。其他设备上的登录已被注销，当前设备继续有效。');
      await loadSessions();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      const dispatch: Dispatch = await api.resendVerification();
      setDevToken(dispatch.devToken);
      setNotice(`验证邮件已发送至 ${dispatch.target ?? '你的邮箱'}。`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setResending(false);
    }
  };

  const verifyNow = async () => {
    if (!devToken) return;
    setResending(true);
    setError(null);
    try {
      await api.verifyEmail(devToken);
      setNotice('邮箱验证成功。');
      setDevToken(null);
      await loadMe();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setResending(false);
    }
  };

  const revoke = async (id: number) => {
    setError(null);
    try {
      await api.revokeSession(id);
      setNotice('该设备已被注销登录。');
      await loadSessions();
    } catch (err) {
      setError(messageOf(err));
    }
  };

  const verified = me?.emailVerified ?? user?.emailVerified ?? false;

  return (
    <div className="page">
      <PageBar
        title="账号与安全"
        subtitle={user?.username ?? ''}
        balance={me?.credits ?? user?.credits ?? null}
        lowBalance={me?.lowBalance ?? user?.lowBalance ?? false}
        active="account"
        onBack={onBack}
        onLogout={onLogout}
      />

      <main className="page-scroll">
        <div className="page-wrap">
          {error && <div className="form-error">{error}</div>}
          {notice && <div className="form-notice">{notice}</div>}

          {/* -------------------------------------------------------- 身份 */}
          <section className="ac-card">
            <div className="ac-card-head">
              <TerminalMark size={18} />
              <span className="ac-card-title">身份信息</span>
            </div>
            <dl className="ac-grid">
              <div>
                <dt>用户名</dt>
                <dd className="mono">{me?.username ?? user?.username ?? '—'}</dd>
              </div>
              <div>
                <dt>邮箱</dt>
                <dd className="mono">{me?.email ?? '未绑定'}</dd>
              </div>
              <div>
                <dt>邮箱状态</dt>
                <dd>
                  <span className={`cr-status ${verified ? 'paid' : 'pending'}`}>
                    {verified ? '已验证' : '未验证'}
                  </span>
                </dd>
              </div>
              <div>
                <dt>角色</dt>
                <dd className="mono">{me?.role ?? user?.role ?? '—'}</dd>
              </div>
            </dl>

            {!verified && (
              <div className="ac-actions">
                <button className="btn btn-sm" onClick={() => void resend()} disabled={resending}>
                  {resending && <span className="spinner" />}
                  重新发送验证邮件
                </button>
                {devToken && (
                  <button className="btn btn-sm btn-primary" onClick={() => void verifyNow()} disabled={resending}>
                    本地开发模式：立即完成验证
                  </button>
                )}
                <span className="ac-hint">
                  未验证的邮箱不能用来找回密码 —— 现在验证，忘记密码时才有退路。
                </span>
              </div>
            )}
          </section>

          {/* -------------------------------------------------------- 改密码 */}
          <section className="ac-card">
            <div className="ac-card-head">
              <KeyIcon size={16} />
              <span className="ac-card-title">修改密码</span>
            </div>
            <form className="form-stack" onSubmit={changePassword}>
              <div className="field">
                <label htmlFor="old-password">当前密码</label>
                <input
                  id="old-password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  value={oldPassword}
                  onChange={(event) => setOldPassword(event.target.value)}
                  placeholder="证明是你本人"
                />
              </div>
              <div className="field">
                <label htmlFor="new-password">新密码</label>
                <input
                  id="new-password"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
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
              <p className="ac-hint">
                改完密码后，其他设备上的登录会全部失效，当前设备会换一对新令牌继续用 ——
                所以这里不会把你踢出去。
              </p>
              <div className="row">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={busy || oldPassword.length === 0 || newPassword.length === 0 || confirm.length === 0}
                >
                  {busy && <span className="spinner" />}
                  修改密码
                </button>
              </div>
            </form>
          </section>

          {/* -------------------------------------------------------- 设备 */}
          <section className="ac-card">
            <div className="ac-card-head">
              <DeviceIcon size={16} />
              <span className="ac-card-title">登录设备</span>
              <span className="ac-count">共 {sessions.length} 台有效</span>
            </div>
            <p className="ac-hint">
              这些是当前还能免密进入你账号的设备（刷新令牌有效期 30 天）。
              看到不认识的，直接注销它 —— 只存 JWT 的系统给不出这份清单。
            </p>

            {sessions.length === 0 ? (
              <p className="cr-empty">暂无可列出的设备。</p>
            ) : (
              <table className="cr-table">
                <thead>
                  <tr>
                    <th>设备</th>
                    <th>IP</th>
                    <th>登录时间</th>
                    <th>令牌到期</th>
                    <th className="act">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((session) => (
                    <tr key={session.id}>
                      <td>{session.device ?? '未知设备'}</td>
                      <td className="mono">{session.ip ?? '—'}</td>
                      <td className="mono dim">{formatDateTime(session.createdAt)}</td>
                      <td className="mono dim">{formatDateTime(session.expiresAt)}</td>
                      <td className="act">
                        <button className="btn btn-sm btn-danger" onClick={() => void revoke(session.id)}>
                          注销
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
