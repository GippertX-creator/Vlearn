/**
 * Electron 主进程入口：
 * - 创建主窗口（渲染进程 + preload）
 * - 初始化 SQLite 数据库并注册全部 IPC 处理器
 * - 支持 --smoke-test 参数：无窗口运行核心业务逻辑自检后退出
 */
import { app, BrowserWindow, shell } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDb } from './db'
import { registerIpcHandlers } from './ipcHandlers'
import { runSmokeTest, runUiSmokeTest } from './smoke'

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

  // 开发模式加载 Vite Dev Server，生产模式加载打包后的静态文件
  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  if (isSmokeTest || isUiSmokeTest) {
    // 冒烟测试模式：使用临时数据库，不污染用户数据
    initDb(join(mkdtempSync(join(tmpdir(), 'vlearn-smoke-')), 'smoke.db'))
  } else {
    initDb()
  }
  registerIpcHandlers()

  if (isSmokeTest || isUiSmokeTest) {
    const test = isSmokeTest ? runSmokeTest : runUiSmokeTest
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
