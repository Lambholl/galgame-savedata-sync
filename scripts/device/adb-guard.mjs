// 发给 adb 的参数在这里逐词检查，命中危险命令就拒绝执行。
// 子命令拼出的参数是固定模板加上校验过的取值，这层检查防的是模板或校验写错时把删除、重启一类命令带到手机上。
// 结束 frida-server 没有子命令，由维护者在手机上处理；删除只开放测试文件的临时区，格式由调用方以 allowedExact 给出。

// 按整词匹配：arm64、force-stop 里的片段不算命中，/system/bin/rm 和 kill-server 算。
// kill-server、reconnect、usb、tcpip 等会重启 adb 进程或改连接方式，之后可能连不回手机。
const DANGEROUS_WORDS = new Set(
  `rm rmdir unlink shred truncate dd mkfs mke2fs format wipe mv
  reboot shutdown poweroff halt stop setprop setenforce mount umount remount
  kill killall pkill kill-server start-server reconnect disconnect root unroot usb tcpip
  sideload uninstall clear disable-verity enable-verity`.split(/\s+/),
)
// 这几个词只在整组参数完全匹配 allowedExact 时放行。
const EXACT_ONLY_WORDS = new Set(['su', 'kill', 'rm'])

// stop、format、clear 等在 frida 脚本里是普通单词，所以只查系统命令。shutdown 也不查：脚本里它几乎总是
// ExecutorService.shutdown()，关机要先经 su、Runtime.exec 或 ProcessBuilder，这几个照样拒绝。
/** frida 脚本源码里不允许出现的系统命令，按整词匹配。 */
export const DANGEROUS_IN_FRIDA_AGENT =
  /\b(rm|rmdir|unlink|reboot|poweroff|kill|killall|pkill|setprop|su|Runtime\.exec|ProcessBuilder)\b/

/**
 * 检查一组 adb 参数。参数拆成词后逐个比对危险命令；su、kill 和 rm 只在整组参数完全匹配 allowedExact 里的某一项时放行。
 * @param {readonly string[]} args 传给 adb 的参数，不含 `-s <序列号>`。
 * @param {readonly RegExp[]} [allowedExact] 允许出现 su、kill 或 rm 的完整参数格式，按空格连接后的整串匹配。
 * @returns {string | null} 拒绝的原因；可以执行时为 null。
 */
export function findRefusal(args, allowedExact = []) {
  const joined = args.join(' ')
  const words = joined
    .toLowerCase()
    .split(/[\s;|&'"()`$<>/=]+/)
    .filter((word) => word !== '')
  const isAllowedExact = allowedExact.some((pattern) => pattern.test(joined))
  for (const word of words) {
    if (EXACT_ONLY_WORDS.has(word)) {
      if (!isAllowedExact) {
        return `${word} 只能用于固定的命令：${joined}`
      }
    } else if (DANGEROUS_WORDS.has(word)) {
      return `参数里有危险命令 ${word}：${joined}`
    }
  }
  return null
}
