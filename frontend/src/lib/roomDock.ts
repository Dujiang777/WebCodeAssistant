type Listener = () => void;

let filePath: string | null = null;
let fileSnapshot: { path: string | null } = { path: null };
const fileListeners = new Set<Listener>();
const openListeners = new Set<Listener>();

function emitFile(): void {
  fileSnapshot = { path: filePath };
  for (const listener of fileListeners) listener();
}

/** 编辑器把当前文件交给讨论室，介绍页上没有文件。 */
export function setRoomFilePath(path: string | null): void {
  if (filePath === path) return;
  filePath = path;
  emitFile();
}

export function subscribeRoomFile(listener: Listener): () => void {
  fileListeners.add(listener);
  return () => {
    fileListeners.delete(listener);
  };
}

export function getRoomFileSnapshot(): { path: string | null } {
  return fileSnapshot;
}

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
