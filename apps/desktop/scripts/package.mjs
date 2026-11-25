// 按本机平台运行对应的打包脚本：Linux 产出 AppImage 和 deb，其他平台由 Windows 打包脚本检查。
await import(process.platform === 'linux' ? './package-linux.mjs' : './package-windows.mjs')
