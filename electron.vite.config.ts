import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

/**
 * electron-vite 配置：
 * - main / preload：打包为 CJS，运行于 Electron 主进程，依赖（better-sqlite3、exceljs 等）保持外部化
 * - renderer：React 渲染进程，使用 Vite 常规打包；base 设为 './' 以支持生产环境 file:// 加载
 * - 入口以绝对路径声明并固定为 index，保证输出为 out/main/index.js 与 out/preload/index.js
 *   （相对路径 electron/main.ts 会被 externalizeDepsPlugin 误判为依赖 "electron" 而外部化）
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: fileURLToPath(new URL('./electron/main.ts', import.meta.url)) }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: fileURLToPath(new URL('./electron/preload.ts', import.meta.url)) }
      }
    }
  },
  renderer: {
    root: '.',
    base: './',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: fileURLToPath(new URL('./index.html', import.meta.url))
      }
    }
  }
})
