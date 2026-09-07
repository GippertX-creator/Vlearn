/**
 * postinstall 包装脚本：调用 electron-builder install-app-deps 将 better-sqlite3
 * 编译为 Electron 可用的原生模块。
 *
 * 若 .npmrc 中配置了 electron_mirror（例如国内镜像），则同步设置 ELECTRON_MIRROR
 * 环境变量，避免从 GitHub 下载 Electron 头文件超时。
 */
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

// 读取项目 .npmrc 中的 electron_mirror 配置
function readMirrorFromNpmrc() {
  try {
    const npmrc = fs.readFileSync(path.join(__dirname, '..', '.npmrc'), 'utf8')
    const match = npmrc.match(/^electron_mirror\s*=\s*(.+)$/m)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

const mirror = process.env.ELECTRON_MIRROR || readMirrorFromNpmrc()
if (mirror) {
  process.env.ELECTRON_MIRROR = mirror
  process.env.npm_config_electron_mirror = mirror
  console.log(`[vlearn] 使用 Electron 镜像：${mirror}`)
}

const args = ['electron-builder', 'install-app-deps']
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})
process.exit(result.status ?? 1)
