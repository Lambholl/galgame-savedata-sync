import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProcNetRoute } from '../src/backend/recommended-address.ts'

// 列顺序和编码来自 Linux 内核的 /proc/net/route：目标、网关、掩码是小端序十六进制，Flags 十六进制，Metric 十进制。
const PROC_NET_ROUTE = [
  'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
  'wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0',
  'eth0\t00000000\t0102A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0',
  'eth0\t00000000\t0102A8C0\t0003\t0\t0\t300\t00000000\t0\t0\t0',
  'eth0\t0002A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0',
  'docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\t0\t0\t0',
  'tun0\t00000000\t00000000\t0000\t0\t0\t50\t00000000\t0\t0\t0',
].join('\n')

test('/proc/net/route 按网卡取默认路由和全部路由的最小 metric，跳过未启用的路由', () => {
  const { defaultRoutes, interfaceRoutes } = parseProcNetRoute(PROC_NET_ROUTE)
  assert.deepEqual(
    defaultRoutes,
    new Map([
      ['wlan0', 600],
      ['eth0', 100],
    ]),
  )
  assert.deepEqual(
    interfaceRoutes,
    new Map([
      ['wlan0', 600],
      ['eth0', 100],
      ['docker0', 0],
    ]),
  )
})
