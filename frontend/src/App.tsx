import { useEffect, useState } from 'react';

import { clearSession, loadUser, setUnauthorizedHandler } from './lib/api';
import type { AuthUser } from './lib/api';
import { navigate, useRoute } from './lib/router';
import { IdePage } from './pages/IdePage';
import { LoginPage } from './pages/LoginPage';
import { WorkspaceListPage } from './pages/WorkspaceListPage';

/**
 * 应用外壳：唯一负责「当前是谁 + 当前在哪个页面」。
 *
 * 两件容易被写散的事集中在这里：
 *   - 401 的统一处理（任何请求触发登出，都会回到登录页，而不是留在原地报错）；
 *   - 路由与登录态的互斥（未登录不允许停在需要鉴权的页面）。
 */
export function App() {
  const [user, setUser] = useState<AuthUser | null>(() => loadUser());
  const route = useRoute();

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      navigate('/login');
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!user && route.name !== 'login') {
      navigate('/login');
    } else if (user && route.name === 'login') {
      navigate('/workspaces');
    }
  }, [user, route.name]);

  const handleLogout = () => {
    clearSession();
    setUser(null);
    navigate('/login');
  };

  if (!user) {
    return <LoginPage onAuthenticated={setUser} />;
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
