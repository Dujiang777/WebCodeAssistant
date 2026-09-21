/**
 * 极简 hash 路由。
 *
 * 为什么不上 react-router：只有三个页面，且 IDE 页面的状态完全由 workspaceId 决定，
 * 引入一个路由库带来的收益（嵌套路由、loader、数据 API）这里一个都用不上。
 * hash 路由还有个实际好处 —— 静态托管（nginx / 任意静态服务器）不需要 rewrite 规则。
 */

import { useEffect, useState } from 'react';

export type Route =
  | { name: 'login' }
  | { name: 'workspaces' }
  | { name: 'ide'; workspaceId: number };

export function parseRoute(hash: string): Route {
  const clean = hash.replace(/^#/, '').replace(/^\/+/, '/');
  const pathPart = clean.split('?')[0];
  const segments = pathPart.split('/').filter(Boolean);

  if (segments.length === 0) return { name: 'workspaces' };
  if (segments[0] === 'login') return { name: 'login' };
  if (segments[0] === 'workspaces') return { name: 'workspaces' };
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

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
