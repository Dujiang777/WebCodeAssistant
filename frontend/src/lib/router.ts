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

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}
