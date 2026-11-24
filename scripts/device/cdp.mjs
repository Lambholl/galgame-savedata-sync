// 经 Chrome DevTools Protocol 在本应用的网页里执行 JavaScript，把结果按 JSON 打印。
// 用来读界面文字和驱动界面，代替截图后按坐标点按。
//
// 用法：node scripts/device/cdp.mjs <端口> <表达式|@脚本.js> [页面 URL 片段]
//       node scripts/device/cdp.mjs <端口> --list
// - Android：先 node scripts/device/device.mjs cdp-forward <端口>；应用重启后进程号变了，要重新转发。
// - 电脑端：调试构建在环境变量 SAVEDATA_SYNC_DEVTOOLS_PORT=<端口> 下启动，WebView2 在这个端口开放 CDP。
// 表达式包在 async 函数体里执行：可以用 await，要返回值就写 return。
// 返回值经 returnByValue 传回，DOM 节点等不能序列化的值会变成空对象，先在页面里转成文本或普通对象。
import { readFileSync } from 'node:fs'

const [port, source, urlPart = ''] = process.argv.slice(2)
if (!/^\d{1,5}$/.test(port ?? '') || !source) {
  console.error('用法：node scripts/device/cdp.mjs <端口> <表达式|@脚本.js|--list> [页面 URL 片段]')
  process.exit(2)
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
if (source === '--list') {
  for (const item of targets) {
    console.log(`${item.type}\t${item.url}`)
  }
  process.exit(0)
}
const expression = source.startsWith('@') ? readFileSync(source.slice(1), 'utf8') : source
const target = targets.find((item) => item.type === 'page' && item.url.includes(urlPart))
if (!target) {
  console.error('没有匹配的页面', JSON.stringify(targets.map((item) => [item.type, item.url])))
  process.exit(2)
}
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = reject
})
socket.onmessage = (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== 1) {
    return
  }
  if (message.error) {
    console.error('协议错误', JSON.stringify(message.error))
    process.exitCode = 1
  } else if (message.result.exceptionDetails) {
    const details = message.result.exceptionDetails
    console.error('页面异常', details.exception?.description ?? JSON.stringify(details))
    process.exitCode = 1
  } else {
    const value = message.result.result.value
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1))
  }
  socket.close()
}
socket.send(
  JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    },
  }),
)
