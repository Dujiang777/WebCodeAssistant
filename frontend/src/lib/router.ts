/**
 * 极简 hash 路由。
 *
 * 为什么不上 react-router：页面数量一只手数得过来，且 IDE 页面的状态完全由
 * workspaceId 决定，引入一个路由库带来的收益（嵌套路由、loader、数据 API）这里一个都用不上。
 * hash 路由还有个实际好处 —— 静态托管（nginx / 任意静态服务器）不需要 rewrite 规则。
 *
 * 一条容易踩的约定：**邮件里发出去的链接是 `/#/verify-email?token=xxx`**，
 * 令牌在 hash 的查询串里而不是 path 里。所以解析时不能只切 `/`，
 * 还要把 `?` 之后的部分单独取出来。
 */

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'login' }
  | { name: 'workspaces' }
  | { name: 'credits' }
  | { name: 'account' }
  | { name: 'models' }
  | { name: 'admin'; tab: string }
  | { name: 'verify-email'; token: string }
  | { name: 'reset-password'; token: string }
  | { name: 'ide'; workspaceId: number };

function queryOf(clean: string): URLSearchParams {
  const at = clean.indexOf('?');
  return new URLSearchParams(at >= 0 ? clean.slice(at + 1) : '');
}

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#/, '');
  const pathPart = clean.split('?')[0].replace(/^\/+/, '/');
  const segments = pathPart.split('/').filter(Boolean);
  const query = queryOf(clean);

  if (segments.length === 0) return { name: 'workspaces' };
  if (segments[0] === 'login') return { name: 'login' };
  if (segments[0] === 'workspaces') return { name: 'workspaces' };
  if (segments[0] === 'credits') return { name: 'credits' };
  if (segments[0] === 'account') return { name: 'account' };
  if (segments[0] === 'models') return { name: 'models' };
  // /#/admin 或 /#/admin/users —— tab 进 hash，刷新后停在同一页
  if (segments[0] === 'admin') return { name: 'admin', tab: segments[1] ?? 'dashboard' };
  // token 缺失时也照样返回该路由，让页面自己提示「链接不完整」——
  // 静默跳回工作区列表只会让人以为是网站坏了。
  if (segments[0] === 'verify-email') return { name: 'verify-email', token: query.get('token') ?? '' };
  if (segments[0] === 'reset-password') return { name: 'reset-password', token: query.get('token') ?? '' };
  if (segments[0] === 'ide') {
    const id = Number(segments[1]);
    if (Number.isInteger(id) && id > 0) return { name: 'ide', workspaceId: id };
  }
  return { name: 'workspaces' };
}

export function navigate(path: string): void {
  const target = path.startsWith('/') ? path : `/${path}`;
  if (window.location.hash === `#${target}`) return;
  window.location.hash = target;
}

/** 把 Route 还原成 hash 路径（previousPath 跟踪与测试都要用）。 */
export function pathOf(route: Route): string {
  switch (route.name) {
    case 'login':
      return '/login';
    case 'workspaces':
      return '/workspaces';
    case 'credits':
      return '/credits';
    case 'account':
      return '/account';
    case 'models':
      return '/models';
    case 'admin':
      return `/admin/${route.tab}`;
    case 'verify-email':
      return `/verify-email?token=${route.token}`;
    case 'reset-password':
      return `/reset-password?token=${route.token}`;
    case 'ide':
      return `/ide/${route.workspaceId}`;
  }
}

// 「来时的路」：二级页（账号/积分/模型服务/管理后台）的返回按钮不该写死回
// 工作区列表 —— 用户明明是从某个工作区的编辑器里点头像菜单进来的，回去就该
// 回到那个编辑器。模块级变量挂在 useRoute 的 hashchange 上逐跳更新。
let currentPath: string | null = null;
let lastPath: string | null = null;

/** 用户所在的上一个页面路径；没有上一跳（刚刷新落地）时为 null。 */
export function previousPath(): string | null {
  return lastPath;
}

// 「最近干活的编辑器」：二级页顶栏那个品牌区点一下要回工作台，但这个目标
// 不能只靠 previousPath —— 那是内存变量，用户在账号页刷新一下它就没了，
// 于是「回工作台」会静默退化成回工作区列表。存 localStorage 里，刷新也在。
// 没有值（从没进过编辑器）时返回 null，由调用方兜底回工作区列表。
const LAST_IDE_KEY = 'wca.last.ide';

/** 记下最近打开的编辑器。进入 IDE 页时调用。 */
export function rememberIde(workspaceId: number): void {
  try {
    localStorage.setItem(LAST_IDE_KEY, String(workspaceId));
  } catch {
    // 隐私模式 / 存储被禁：记不住就算了，品牌区会退化成回工作区列表
  }
}

/** 最近打开的编辑器路径；从没进过编辑器时为 null。 */
export function lastIdePath(): string | null {
  try {
    const id = Number(localStorage.getItem(LAST_IDE_KEY));
    return Number.isInteger(id) && id > 0 ? `/ide/${id}` : null;
  } catch {
    return null;
  }
}

/** 最近打开的工作区 id，列表页用来标「上次打开」。 */
export function lastIdeWorkspaceId(): number | null {
  try {
    const id = Number(localStorage.getItem(LAST_IDE_KEY));
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    // 初次挂载先校准当前位置，否则第一次跳转时 previous 会少记一跳
    if (currentPath === null) currentPath = pathOf(parseRoute(window.location.hash));

    const onChange = () => {
      const next = parseRoute(window.location.hash);
      const nextPath = pathOf(next);
      if (nextPath !== currentPath) {
        lastPath = currentPath;
        currentPath = nextPath;
      }
      setRoute(next);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
