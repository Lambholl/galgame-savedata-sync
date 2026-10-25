import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

test(
  'Windows 短路径 TEMP 下目录与 IPC 测试仍通过',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const temporaryRoot = await realpath(tmpdir())
    const base = await mkdtemp(join(temporaryRoot, 'savedata-short-temp-test-'))
    t.after(async () => {
      const child = relative(temporaryRoot, base)
      assert.ok(child && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
      assert.ok(base.includes('savedata-short-temp-test-'))
      await rm(base, { recursive: true, force: true })
    })

    // 通过 Windows API 查询实际别名，不依赖用户名、硬编码短名或系统编码。
    const { stdout } = await runFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Add-Type -Name NativePath -Namespace SaveDataSyncTest -MemberDefinition '
        [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
        public static extern uint GetShortPathName(string path, System.Text.StringBuilder result, uint size);';
      $buffer = [System.Text.StringBuilder]::new(32768);
      $length = [SaveDataSyncTest.NativePath]::GetShortPathName($env:SAVEDATA_TEST_TEMP, $buffer, 32768);
      if ($length -eq 0 -or $length -ge 32768) { throw 'GetShortPathName failed' };
      [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($buffer.ToString()))`,
      ],
      { env: { ...process.env, SAVEDATA_TEST_TEMP: base }, windowsHide: true, timeout: 30_000 },
    )
    const shortPath = Buffer.from(stdout.trim(), 'base64').toString('utf8')
    const canonicalPath = await realpath(shortPath)
    assert.equal(relative(base, canonicalPath), '')
    if (relative(shortPath, canonicalPath) === '') {
      t.skip('此卷未为测试目录生成不同的 8.3 别名')
      return
    }

    // 只启动两套目标测试，避免递归执行本回归；环境变量仅影响子进程。
    const testEnvironment = { ...process.env, TEMP: shortPath, TMP: shortPath }
    // 子进程是独立测试入口，不能继承父测试器的内部执行上下文。
    delete testEnvironment.NODE_TEST_CONTEXT
    const result = await runFile(
      process.execPath,
      [
        '--experimental-strip-types',
        '--test',
        '--test-reporter=tap',
        fileURLToPath(new URL('./directory-adapter.test.mjs', import.meta.url)),
        fileURLToPath(new URL('./directory-ipc.test.mjs', import.meta.url)),
      ],
      {
        env: testEnvironment,
        windowsHide: true,
        timeout: 30_000,
      },
    )
    const testCount = Number(/# tests (\d+)\b/.exec(result.stdout)?.[1])
    const passedCount = Number(/# pass (\d+)\b/.exec(result.stdout)?.[1])
    assert.ok(testCount > 0)
    assert.equal(passedCount, testCount)
    assert.match(result.stdout, /# fail 0\b/)
    assert.match(result.stdout, /# skipped 0\b/)
  },
)
