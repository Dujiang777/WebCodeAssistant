import { useEffect, useState } from 'react';

import { api, clearSession, loadRefreshToken, loadUser, patchUser, subscribeSession } from './lib/api';
import type { AuthUser } from './lib/api';
import { navigate, useRoute } from './lib/router';
import { AccountPage } from './pages/AccountPage';
import { ResetPasswordPage, VerifyEmailPage } from './pages/AuthTokenPage';
import { CreditsPage } from './pages/CreditsPage';
import { IdePage } from './pages/IdePage';
import { LoginPage } from './pages/LoginPage';
import { WorkspaceListPage } from './pages/WorkspaceListPage';

/** 不需要登录态就能打开的页面（邮件链接落点、登录页）。 */
const ANONYMOUS_ROUTES = new Set(['login', 'verify-email', 'reset-password']);

/**
 * 应用外壳：唯一负责「当前是谁 + 当前在哪个页面」。
 *
 * 四件容易被写散的事集中在这里：
 *   - 登录态只有一个来源（api 的会话存储），任何地方 clearSession 都会经订阅回到登录页，
 *     不需要每个页面自己判断「我是不是掉线了」；
 *   - 首屏用 `/me` 校准一次：本地缓存里的余额、邮箱验证状态、角色都可能已经变了；
 *   - 路由与登录态的互斥（未登录不允许停在需要鉴权的页面），但**邮件链接是例外** ——
 *     用户在另一个浏览器点验证链接时通常并没有登录态；
 *   - 退出登录先吊销 refresh 再清本地，否则服务端那条会话会一直存活到自然过期。
 */
export function App() {
  const [user, setUser] = useState<AuthUser | null>(() => loadUser());
  const route = useRoute();

  // 会话唯一真源：登录 / 刷新 / 登出都会推到这里，页面不需要各自处理 401
  useEffect(() => subscribeSession(setUser), []);

  // 首屏校准：余额与邮箱验证状态是会变的，localStorage 里的只是上次的快照
  useEffect(() => {
    if (!loadUser()) return;
    let cancelled = false;
    void (async () => {
      try {
        const me = await api.me();
        if (cancelled) return;
        patchUser({
          userId: me.userId,
          username: me.username,
          email: me.email,
          emailVerified: me.emailVerified,
          role: me.role,
          credits: me.credits,
          lowBalance: me.lowBalance,
          enforceBalance: me.enforceBalance,
        });
      } catch {
        // 401 已经由 api 层清掉会话；其它错误（后端刚重启等）不该把人踢走
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.userId]);

  useEffect(() => {
    if (!user && !ANONYMOUS_ROUTES.has(route.name)) {
      navigate('/login');
    } else if (user && route.name === 'login') {
      navigate('/workspaces');
    }
  }, [user, route.name]);

  const handleLogout = () => {
    const refreshToken = loadRefreshToken();
    // 吊销失败也要继续清本地 —— 用户点了退出就必须退出去
    if (refreshToken) void api.logout(refreshToken).catch(() => undefined);
    clearSession();
    navigate('/login');
  };

  // 邮件链接落点：这两个页面在未登录状态下也要能打开
  if (route.name === 'verify-email') {
    return <VerifyEmailPage token={route.token} onDone={() => navigate('/workspaces')} />;
  }
  if (route.name === 'reset-password') {
    return <ResetPasswordPage token={route.token} onDone={() => navigate('/login')} />;
  }

  if (!user) {
    return <LoginPage onAuthenticated={setUser} />;
  }

  if (route.name === 'credits') {
    return <CreditsPage onBack={() => navigate('/workspaces')} onLogout={handleLogout} />;
  }

  if (route.name === 'account') {
    return <AccountPage onBack={() => navigate('/workspaces')} onLogout={handleLogout} />;
  }

  if (route.name === 'ide') {
    // key 绑定 workspaceId：切换工作区时整个 IDE 状态整块重建，避免上一份文件/会话残留
    return (
      <IdePage
        key={route.workspaceId}
        workspaceId={route.workspaceId}
        username={user.username}
        onLogout={handleLogout}
      />
    );
  }

  return <WorkspaceListPage username={user.username} onLogout={handleLogout} />;
}
