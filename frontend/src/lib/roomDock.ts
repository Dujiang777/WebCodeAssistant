type Listener = () => void;

export interface RoomCode {
  path: string | null;
  excerpt: string | null;
  startLine: number | null;
  endLine: number | null;
  clipped: boolean;
}

const EMPTY_CODE: RoomCode = {
  path: null,
  excerpt: null,
  startLine: null,
  endLine: null,
  clipped: false,
};

let codeSnapshot: RoomCode = EMPTY_CODE;
const fileListeners = new Set<Listener>();
const openListeners = new Set<Listener>();

function sameCode(a: RoomCode, b: RoomCode): boolean {
  return a.path === b.path
    && a.excerpt === b.excerpt
    && a.startLine === b.startLine
    && a.endLine === b.endLine
    && a.clipped === b.clipped;
}

/** 编辑器把选中的代码交给讨论室。介绍页上没有编辑器，就是空的。 */
export function setRoomCode(next: RoomCode): void {
  if (sameCode(codeSnapshot, next)) return;
  codeSnapshot = next;
  for (const listener of fileListeners) listener();
}

export function subscribeRoomFile(listener: Listener): () => void {
  fileListeners.add(listener);
  return () => {
    fileListeners.delete(listener);
  };
}

export function getRoomCodeSnapshot(): RoomCode {
  return codeSnapshot;
}

export { EMPTY_CODE };

/** 工具栏点「讨论室」时把悬浮框展开。每次点击都会通知，即使已经开着。 */
export function openRoomDock(): void {
  for (const listener of openListeners) listener();
}

export function subscribeRoomOpen(listener: Listener): () => void {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
}

const RETURN_KEY = 'wca.room.return';

/** 介绍页上还没登录就点了讨论室：登录成功后要回到这一页并把框打开。 */
export function rememberRoomLogin(): void {
  try {
    sessionStorage.setItem(RETURN_KEY, '1');
  } catch {
    // 存不住就按普通登录走，进工作区列表
  }
}

export function peekRoomLogin(): boolean {
  try {
    return sessionStorage.getItem(RETURN_KEY) === '1';
  } catch {
    return false;
  }
}

export function consumeRoomLogin(): void {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // 清不掉也只会影响下一次登录落点
  }
}
