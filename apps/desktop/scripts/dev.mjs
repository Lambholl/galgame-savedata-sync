// pnpm dev（桌面端）：选一个空闲端口启动界面开发服务器和 Tauri 宿主。
// 首选端口取 src-tauri/tauri.conf.json 的 devUrl，被占用时往后找；devUrl、启动 Vite 的命令和 devCsp
// 里的热更新地址经 tauri dev --config 一起换成实际端口。
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { findFreePort } from '../../../scripts/free-port.mjs'

const DESKTOP_ROOT = fileURLToPath(new URL('..', import.meta.url))
// out/ 已被 Git 忽略。
const OVERRIDE_FILE = 'out/tauri-dev.conf.json'

const config = JSON.parse(
  readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
)
const preferred = new URL(config.build.devUrl)
const port = await findFreePort(preferred.hostname, Number(preferred.port))
const origin = `${preferred.hostname}:${port}`
const devCsp = config.app.security.devCsp
if (!devCsp.includes(`ws://${preferred.host}`)) {
  throw new Error(`devCsp in tauri.conf.json must allow ws://${preferred.host}.`)
}
const override = {
  build: {
    devUrl: `${preferred.protocol}//${origin}`,
    // 端口参数接在最后一条命令，也就是启动 Vite 的 dev:renderer 后面；Vite 以 strictPort 启动，端口在这之后被占用时直接失败。
    beforeDevCommand: `${config.build.beforeDevCommand} --port ${port}`,
  },
  app: { security: { devCsp: devCsp.replace(`ws://${preferred.host}`, `ws://${origin}`) } },
}
mkdirSync(new URL('../out/', import.meta.url), { recursive: true })
writeFileSync(new URL(`../${OVERRIDE_FILE}`, import.meta.url), JSON.stringify(override, null, 2))

const tauri = spawn('pnpm', ['exec', 'tauri', 'dev', '--config', OVERRIDE_FILE], {
  cwd: DESKTOP_ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
tauri.on('exit', (code) => {
  process.exitCode = code ?? 1
})
