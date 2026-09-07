import type { VlearnApi } from './types'

declare global {
  interface Window {
    /** preload 暴露的主进程能力，渲染进程唯一的数据通道 */
    api: VlearnApi
  }
}

export {}
