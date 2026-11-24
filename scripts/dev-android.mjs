// pnpm dev:android：在电脑上启动移动端的 Vite，并把手机上 android:build:dev-server 构建的应用打开的端口转到它。
// 电脑上的端口从 5173 往后找空闲的；手机上的端口固定，由 device.mjs reverse 接到实际端口。
// Vite 在本进程里运行，结束这个命令时 Vite 一起结束，不会留下占着端口的进程。
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { findFreePort } from './free-port.mjs'

const HOST = '127.0.0.1'
const MOBILE_ROOT = fileURLToPath(new URL('../apps/mobile/', import.meta.url))
const DEVICE_TOOL = fileURLToPath(new URL('./device/device.mjs', import.meta.url))

const port = await findFreePort(HOST, 5173)
const reverse = spawnSync(process.execPath, [DEVICE_TOOL, 'reverse', String(port)], {
  stdio: 'inherit',
})
if (reverse.status !== 0) {
  process.exit(reverse.status ?? 1)
}
// strictPort：端口在上面检查之后被占用时直接失败，否则 Vite 换到别的端口，手机就连不上了。
// 页面里的热更新客户端按页面地址的端口连接，也就是手机上的端口，经同一个转发到达电脑。
const server = await createServer({
  root: MOBILE_ROOT,
  configFile: join(MOBILE_ROOT, 'vite.config.ts'),
  server: { host: HOST, port, strictPort: true },
})
await server.listen()
server.printUrls()
server.bindCLIShortcuts({ print: true })
