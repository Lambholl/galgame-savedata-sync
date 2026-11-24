# /// script
# requires-python = ">=3.12"
# ///
"""把 frida 脚本附加到本应用进程，保持若干秒后卸载。

由 device.mjs frida-attach 经 uv 运行，危险词检查、frida-server 状态和进程号都在 device.mjs 里，不要直接运行。
frida 的版本由 device.mjs 按 fridaServer 配置里 frida-server 的版本经 uv run --with 指定，和手机上的版本一致。

用法：uv run --with frida==<版本> --script attach.py --serial <设备序列号> --pid <进程号> --script-path <脚本.js> --seconds <保持秒数>

Frida 17 起 Java 桥不再内置，脚本里要用 Java 层 hook 时开头写

    import Java from 'frida-java-bridge';

这时本程序用 frida.Compiler 把脚本和本目录 node_modules 里锁定版本的 frida-java-bridge 打包后再附加；
桥的版本写在本目录 package.json，第一次使用或换版本后在本目录运行 npm ci。
脚本只能 import 'frida-java-bridge'：危险词检查只看脚本源码，被引入的代码不经检查，只有锁定版本的官方桥例外。
不写 import 的脚本按原样加载，只能用 Interceptor、Module 等内置 API。
"""

import argparse
import re
import shutil
import sys
import time
from pathlib import Path

import frida

AGENT_ROOT = Path(__file__).resolve().parent
BRIDGE = 'frida-java-bridge'
# 打包前把脚本复制到这里，Compiler 才能从 AGENT_ROOT/node_modules 解析桥；文件已被 Git 忽略。
STAGED_NAME = '.staged-agent.js'
IMPORT_PATTERN = re.compile(r'''\bimport\b[^'"]*?['"]([^'"]+)['"]|\bimport\s*\(|\brequire\s*\(''')


def on_message(message: dict, _data: bytes | None) -> None:
    if message['type'] == 'send':
        print(f'[send] {message["payload"]}', flush=True)
    else:
        print(f'[{message["type"]}] {message}', flush=True)


def load_code(path: Path) -> str:
    """返回要附加的代码：引入了 Java 桥的脚本打包后返回，其他脚本原样返回。

    Raises:
        ValueError: 引入了桥以外的模块、用了动态 import 或 require，或本目录没有安装桥。
    """
    source = path.read_text(encoding='utf-8')
    imports = [match.group(1) for match in IMPORT_PATTERN.finditer(source)]
    if not imports:
        return source
    if any(name != BRIDGE for name in imports):
        raise ValueError(f'脚本只能 import {BRIDGE}，实际引入了 {imports}')
    if not (AGENT_ROOT / 'node_modules' / BRIDGE).is_dir():
        raise ValueError(f'{AGENT_ROOT} 下没有安装 {BRIDGE}，先在该目录运行 npm ci')
    shutil.copyfile(path, AGENT_ROOT / STAGED_NAME)
    return frida.Compiler().build(STAGED_NAME, project_root=str(AGENT_ROOT))


def main() -> int:
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--serial', required=True)
    parser.add_argument('--pid', required=True, type=int)
    parser.add_argument('--script-path', required=True, type=Path)
    parser.add_argument('--seconds', required=True, type=int)
    options = parser.parse_args()
    try:
        code = load_code(options.script_path)
    except ValueError as cause:
        print(f'拒绝加载：{cause}', file=sys.stderr)
        return 2
    device = frida.get_usb_device()
    if device.id != options.serial:
        print(f'USB 设备是 {device.id}，不是 {options.serial}', file=sys.stderr)
        return 2
    session = device.attach(options.pid)
    script = session.create_script(code)
    script.on('message', on_message)
    script.load()
    time.sleep(options.seconds)
    script.unload()
    session.detach()
    return 0


if __name__ == '__main__':
    sys.exit(main())
