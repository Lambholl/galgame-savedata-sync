import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 目录清单里目录条目的哈希位置写的值。 */
export const DIRECTORY_MARK = 'directory'

/**
 * 列出本机目录下全部文件的 SHA-256 和全部子目录，路径相对于 root、用 `/` 分隔。
 * 符号链接和其他特殊文件不列出。
 * @param {string} root 要列出的目录。
 * @returns {Promise<Map<string, string>>} 路径到 SHA-256（小写十六进制）的映射；目录的值是 DIRECTORY_MARK，路径以 `/` 结尾。
 */
export async function hashTree(root) {
  const result = new Map()
  async function visit(directory, prefix) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`
      if (entry.isDirectory()) {
        result.set(`${path}/`, DIRECTORY_MARK)
        await visit(join(directory, entry.name), `${path}/`)
      } else if (entry.isFile()) {
        result.set(path, await hashFile(join(directory, entry.name)))
      }
    }
  }
  await visit(root, '')
  return result
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

/**
 * 解析 `sha256sum` 风格的清单：每行 `<哈希或 DIRECTORY_MARK>  <路径>`，路径可以带 `./` 前缀。
 * @param {string} text 清单文本，可以用 CRLF 换行。
 * @returns {Map<string, string>}
 * @throws {Error} 有一行不是这个格式。
 */
export function parseListing(text) {
  const result = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      continue
    }
    const match = /^([0-9a-f]{64}|directory) {2}(?:\.\/)?(.+)$/.exec(line)
    if (!match) {
      throw new Error(`清单格式不对：${line}`)
    }
    result.set(match[2], match[1])
  }
  return result
}

/**
 * 把清单按路径的 UTF-16 码元顺序排好，输出 `<哈希或 DIRECTORY_MARK>  <路径>` 的文本。
 * @param {Map<string, string>} listing
 * @returns {string} 每行以 LF 结尾。
 */
export function formatListing(listing) {
  return [...listing.keys()]
    .sort()
    .map((path) => `${listing.get(path)}  ${path}\n`)
    .join('')
}

/**
 * 比较两份清单。
 * @param {Map<string, string>} left
 * @param {Map<string, string>} right
 * @returns {string[]} 每个不一致的路径一行：`只在左边`、`只在右边` 或 `内容不同`，按路径排序；两份相同时为空数组。
 */
export function diffListings(left, right) {
  const paths = [...new Set([...left.keys(), ...right.keys()])].sort()
  const differences = []
  for (const path of paths) {
    if (!right.has(path)) {
      differences.push(`只在左边  ${path}`)
    } else if (!left.has(path)) {
      differences.push(`只在右边  ${path}`)
    } else if (left.get(path) !== right.get(path)) {
      differences.push(`内容不同  ${path}`)
    }
  }
  return differences
}
