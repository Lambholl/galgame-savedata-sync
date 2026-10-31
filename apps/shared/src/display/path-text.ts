/**
 * 把显示路径切成以分隔符结尾的片段，供界面在分隔符后提供换行点。
 * 同时识别 `/` 与 `\`，不解析、不归一化路径；空字符串返回空数组，拼回去与原文完全一致。
 */
export function splitPathAtSeparators(path: string): string[] {
  return path.match(/[^/\\]*(?:[/\\]|$)/g)?.filter((segment) => segment !== '') ?? []
}
