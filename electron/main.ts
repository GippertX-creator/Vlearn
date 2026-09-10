/**
 * Electron 主进程入口（v2）：
 * - 初始化三个角色数据库（教务/财务/助教），旧版单库自动迁移
 * - 初始化角色登录会话（持久化于 auth.json）
 * - 注册全部 IPC 处理器（每个通道均做角色权限校验）
 * - 支持 --smoke-test / --smoke-ui 无窗口自检模式
 */
import { app, BrowserWindow, shell } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initAuth } from './auth'
import { initDatabases } from './db'
import { registerIpcHandlers } from './ipcHandlers'
import { runSmokeTest, runUiSmokeTest } from './smoke'
import { initBackupScheduler } from './backupScheduler'
import { initSync } from './sync'

const isSmokeTest = process.argv.includes('--smoke-test')
const isUiSmokeTest = process.argv.includes('--smoke-ui')

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    title: 'Vlearn 教培管理系统',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  // 外部链接使用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 冒烟测试模式使用临时数据目录，不污染用户数据
  let smokeDir: string | undefined
  if (isSmokeTest || isUiSmokeTest) {
    smokeDir = mkdtempSync(join(tmpdir(), 'vlearn-smoke-'))
    initDatabases(smokeDir)
    initAuth(smokeDir)
    initSync(smokeDir)
  } else {
    initDatabases()
    initAuth(app.getPath('userData'))
    initSync(app.getPath('userData'))
    initBackupScheduler(app.getPath('userData'))
  }
  registerIpcHandlers()

  if (isSmokeTest || isUiSmokeTest) {
    const test = isSmokeTest ? () => runSmokeTest(smokeDir!) : runUiSmokeTest
    test()
      .then(() => app.exit(0))
      .catch((err) => {
        console.error('冒烟测试失败：', err)
        app.exit(1)
      })
    return
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || isSmokeTest || isUiSmokeTest) app.quit()
})
