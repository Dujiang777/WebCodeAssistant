/**
 * 文件树上的「问 / 改」。
 *
 * 树以前只能打开文件，对话只能打字。这两句把路径写进输入框或直接发出去，
 * 并带上真实路径，好让这一轮走 EDIT 档而不是空转。
 */

export function treeExplain(path: string): string {
  return `解释一下 \`${path}\`：它在这个项目里干什么、关键方法和风险。`;
}

export function treeEdit(path: string): string {
  return `给 \`${path}\` 出一张补丁。我想改的是：`;
}
