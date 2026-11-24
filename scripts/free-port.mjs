// 开发服务器的端口选择：常用端口可能被别的程序占着，从首选端口往后找一个空闲的。
import { createServer } from 'node:net'

const MAX_ATTEMPTS = 50

/**
 * 从 preferred 开始往后找 host 上第一个能监听的端口。
 * 找到后立即释放，调用方启动服务器前端口可能又被占用，服务器要用固定端口模式启动，冲突时直接报错。
 * @param {string} host 要监听的地址，如 `127.0.0.1`。
 * @param {number} preferred 首选端口。
 * @returns {Promise<number>}
 * @throws {Error} 连续 MAX_ATTEMPTS 个端口都被占用，或遇到端口占用以外的监听错误时。
 */
export async function findFreePort(host, preferred) {
  for (let port = preferred; port < preferred + MAX_ATTEMPTS; port += 1) {
    if (await canListen(host, port)) {
      return port
    }
  }
  throw new Error(`No free port on ${host} from ${preferred} to ${preferred + MAX_ATTEMPTS - 1}.`)
}

function canListen(host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', (error) => {
      // Windows 上被系统保留的端口段报 EACCES，同样换下一个端口。
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve(false)
      } else {
        reject(error)
      }
    })
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}
