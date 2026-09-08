/**
 * 外部大模型 API 客户端（OpenAI 兼容协议，如 DeepSeek、通义、GPT 等）。
 * - 配置：各角色在"系统设置 → Agent 配置"中填写 API URL 与 API Key，
 *   存储于各自数据库的 settings（ai_api_url / ai_api_key）。
 * - 参数：模型名、温度、提示词由开发者按功能预设（settings.ai_model 可被
 *   技术人员通过数据库覆盖，界面不开放，保持"用户不可修改参数"的约束）。
 * - 未配置 API 时抛出 AINotConfiguredError，调用方可回退到本地模板方案。
 */
import { getSettingValue, Role } from './db'

/** 未配置大模型 API 的专用错误 */
export class AINotConfiguredError extends Error {
  constructor() {
    super('未配置大模型 API，请先在「系统设置 → Agent 配置」中填写 API 地址和密钥')
    this.name = 'AINotConfiguredError'
  }
}

/** 开发者预设默认模型（OpenAI 兼容，可按提供方通过 ai_model 覆盖） */
const DEFAULT_MODEL = 'deepseek-chat'

/** 各功能的预设温度 */
const FEATURE_TEMPERATURE: Record<string, number> = {
  sms: 0.7, // 微信短信：自然得体
  report: 0.5, // 周报/月报：规整严谨
  trend: 0.4, // 趋势分析：保守
  voucher: 0.3 // 凭证/报表：几乎确定性输出
}

/** 读取某角色的大模型配置 */
export function getAIConfig(role: Role): { apiUrl: string; apiKey: string; model: string } {
  const apiUrl = (getSettingValue(role, 'ai_api_url') ?? '').trim()
  const apiKey = (getSettingValue(role, 'ai_api_key') ?? '').trim()
  const model = (getSettingValue(role, 'ai_model') ?? '').trim() || DEFAULT_MODEL
  return { apiUrl, apiKey, model }
}

/** 判断角色是否已配置大模型 API */
export function isAIConfigured(role: Role): boolean {
  const c = getAIConfig(role)
  return !!(c.apiUrl && c.apiKey)
}

/**
 * 调用大模型生成文本。
 * @param role 角色（决定读取哪个库的 API 配置）
 * @param feature 功能名（决定预设温度，如 sms/report/trend/voucher）
 * @param systemPrompt 系统提示词（开发者预设）
 * @param userPrompt 用户输入（由本地数据组织）
 * @returns 模型输出文本
 */
export async function callLLM(role: Role, feature: string, systemPrompt: string, userPrompt: string): Promise<string> {
  const { apiUrl, apiKey, model } = getAIConfig(role)
  if (!apiUrl || !apiKey) throw new AINotConfiguredError()

  const endpoint = apiUrl.replace(/\/+$/, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: FEATURE_TEMPERATURE[feature] ?? 0.5,
        stream: false
      }),
      signal: controller.signal
    })

    if (!resp.ok) {
      let detail = ''
      try {
        const errJson = (await resp.json()) as { error?: { message?: string } }
        detail = errJson?.error?.message ?? ''
      } catch {
        /* 响应体不是 JSON */
      }
      throw new Error(`大模型 API 请求失败（HTTP ${resp.status}）${detail ? '：' + detail : ''}`)
    }

    const data = (await resp.json()) as {
      choices?: { message?: { content?: string } }[]
      error?: { message?: string }
    }
    if (data?.error?.message) throw new Error(`大模型 API 返回错误：${data.error.message}`)
    const content = data?.choices?.[0]?.message?.content?.trim()
    if (!content) throw new Error('大模型 API 返回内容为空')
    return content
  } catch (err) {
    if (err instanceof AINotConfiguredError) throw err
    if ((err as Error).name === 'AbortError') throw new Error('大模型 API 请求超时（30 秒），请检查网络或更换 API 地址')
    throw err
  } finally {
    clearTimeout(timer)
  }
}
