/** 2026-10-20 官方 Node.js 安全发布基线；仅支持维护中的 22.x / 24.x。 */
export const NODE_SECURITY_BASELINES = Object.freeze({ 22: [22, 23, 4], 24: [24, 22, 1] })

/**
 * 检查数字形式的 Node 版本是否达到项目已知的安全补丁下限。
 * 版本格式错误或主版本不受支持时返回 false；不执行 I/O。
 * @param {string} version 不含 v 前缀的 major.minor.patch 数字版本。
 * @returns {boolean} 版本是否达到受支持 LTS 的补丁下限。
 */
export function isNodeSecurityBaselineMet(version) {
  const actual = version.split('.').map(Number)
  if (actual.length !== 3 || actual.some((part) => !Number.isInteger(part))) {
    return false
  }
  const minimum = NODE_SECURITY_BASELINES[actual[0]]
  if (!minimum) {
    return false
  }
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i] !== minimum[i]) {
      return actual[i] > minimum[i]
    }
  }
  return true
}
