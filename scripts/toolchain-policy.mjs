/** 2026-10-20 官方 Node.js 安全发布基线；仅支持维护中的 22.x / 24.x。 */
export const NODE_SECURITY_BASELINES = Object.freeze({ 22: [22, 23, 4], 24: [24, 22, 1] })

/**
 * Checks a numeric Node version against the project's known security patch floor.
 * Returns false for malformed versions or unsupported major lines; performs no I/O.
 * @param {string} version Numeric major.minor.patch version without a v prefix.
 * @returns {boolean} Whether the version meets a supported LTS patch floor.
 */
export function isNodeSecurityBaselineMet(version) {
  const actual = version.split('.').map(Number)
  if (actual.length !== 3 || actual.some((part) => !Number.isInteger(part))) return false
  const minimum = NODE_SECURITY_BASELINES[actual[0]]
  if (!minimum) return false
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i]
  }
  return true
}
