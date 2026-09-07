/**
 * 渲染进程 API 封装：统一从 window.api 取值并处理 IPC 错误信息。
 * Electron 会把主进程抛出的异常包装为 "Error invoking remote method 'xxx': Error: 原始信息"，
 * 此处提取原始信息，便于向用户展示友好的中文提示。
 */
import type { VlearnApi } from './types'

export function getErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  // 去掉 Electron 的包装前缀，只保留业务异常信息
  return raw.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
}

/** 直接从 window.api 调用并提取错误信息 */
export const api: VlearnApi = window.api

/**
 * 调用 IPC 方法并捕获异常：失败时返回 { ok: false, error }，不向外抛错。
 * 适合表单提交等需要就地提示错误的场景。
 */
export async function tryApi<T>(fn: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const data = await fn()
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) }
  }
}
