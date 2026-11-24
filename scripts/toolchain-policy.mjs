// Node 安全补丁的判断规则：版本所在的主版本还在官方维护期内，且不低于这个主版本最新的安全发布。
// 安全发布和维护期都在运行时向官方查询，新补丁发布后不用改代码。
const RELEASES_URL = 'https://nodejs.org/dist/index.json'
const SCHEDULE_URL = 'https://raw.githubusercontent.com/nodejs/Release/main/schedule.json'
const TIMEOUT_MS = 30_000

/**
 * @typedef {object} NodeReleaseData
 * @property {{ version: string, security: boolean }[]} releases 官方发行记录，version 带 v 前缀。
 * @property {Record<string, { end: string }>} schedule 各主版本的维护期，键形如 `v22`，end 是 `YYYY-MM-DD`。
 */

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!response.ok) {
    throw new Error(`${url} HTTP ${response.status}`)
  }
  return response.json()
}

/**
 * 向官方查询 Node 的发行记录和维护期。
 * @returns {Promise<NodeReleaseData>}
 * @throws {Error} 请求失败、超时或返回的格式不对时。
 */
export async function fetchNodeReleaseData() {
  const [releases, schedule] = await Promise.all([fetchJson(RELEASES_URL), fetchJson(SCHEDULE_URL)])
  if (!Array.isArray(releases) || typeof schedule !== 'object' || schedule === null) {
    throw new Error('Invalid Node.js release data')
  }
  return { releases, schedule }
}

function parseVersion(version) {
  const parts = version.replace(/^v/, '').split('.').map(Number)
  return parts.length === 3 && parts.every(Number.isInteger) ? parts : null
}

function compareVersions(left, right) {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) {
      return left[i] - right[i]
    }
  }
  return 0
}

/**
 * 判断 Node 版本是否还在维护期内，且不低于所在主版本最新的安全发布。
 * @param {string} version major.minor.patch，可以带 v 前缀。
 * @param {NodeReleaseData} data fetchNodeReleaseData 的结果。
 * @param {Date} [now] 判断维护期用的时间。
 * @returns {{ isMet: boolean, detail: string }} 版本格式不对时 isMet 为 false；detail 是给人看的说明，不达标时写要求的最低版本或主版本已停止维护。
 */
export function assessNodeVersion(version, data, now = new Date()) {
  const actual = parseVersion(version)
  if (!actual) {
    return { isMet: false, detail: `cannot parse version ${version}` }
  }
  const line = data.schedule[`v${actual[0]}`]
  const today = now.toISOString().slice(0, 10)
  if (!line || today > line.end) {
    return {
      isMet: false,
      detail: `Node.js ${actual[0]}.x is not maintained; use a maintained LTS line`,
    }
  }
  const latest = data.releases
    .filter((release) => release.security)
    .map((release) => parseVersion(release.version))
    .filter((parts) => parts && parts[0] === actual[0])
    .sort(compareVersions)
    .at(-1)
  if (!latest || compareVersions(actual, latest) >= 0) {
    return { isMet: true, detail: `at or above the latest ${actual[0]}.x security release` }
  }
  return {
    isMet: false,
    detail: `use ${latest.join('.')}+, the latest ${actual[0]}.x security release`,
  }
}
