/**
 * 角色登录会话管理：
 * - 三种角色（教务 academic / 财务 finance / 助教 assistant），密码各自独立，
 *   哈希存储于各自数据库的 settings.password_hash。
 * - 登录状态持久化到 userData/auth.json（角色 + 随机 token），
 *   下次启动自动进入该角色主界面，直至手动"退出登录"。
 * - 主进程所有 IPC 均通过 requireRole() 校验会话，前端任何绕过都无法越权。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDb, getSettingValue, Role, setSettingValue, sha256 } from './db'

interface Session {
  role: Role
  token: string
}

let session: Session | null = null
let authFilePath = ''

/** 初始化：读取持久化的登录状态 */
export function initAuth(dir: string): void {
  authFilePath = path.join(dir, 'auth.json')
  try {
    if (fs.existsSync(authFilePath)) {
      const raw = JSON.parse(fs.readFileSync(authFilePath, 'utf8')) as Session
      if (raw.role && raw.token) session = { role: raw.role, token: raw.token }
    }
  } catch {
    session = null
  }
}

/** 当前登录角色（未登录返回 null） */
export function currentRole(): Role | null {
  return session?.role ?? null
}

/** 当前会话信息（渲染层查询用） */
export function getSession(): Session | null {
  return session
}

/**
 * 角色密码验证 + 建立会话。
 * @returns { success, error? }
 */
export function login(role: Role, password: string): { success: boolean; error?: string } {
  const hash = getSettingValue(role, 'password_hash')
  if (!hash) return { success: false, error: '角色尚未初始化，请联系技术支持' }
  if (sha256(String(password ?? '')) !== hash) return { success: false, error: '密码错误，请重试' }
  const token = crypto.randomUUID()
  session = { role, token }
  persist()
  return { success: true }
}

/** 退出登录：清除会话与持久化文件 */
export function logout(): void {
  session = null
  try {
    if (authFilePath && fs.existsSync(authFilePath)) fs.rmSync(authFilePath)
  } catch {
    /* 忽略 */
  }
}

/** 修改当前会话角色的密码（验证旧密码） */
export function changePassword(oldPassword: string, newPassword: string): { success: boolean; error?: string } {
  const role = session?.role
  if (!role) return { success: false, error: '未登录' }
  const hash = getSettingValue(role, 'password_hash')
  if (hash && sha256(String(oldPassword ?? '')) !== hash) return { success: false, error: '当前密码不正确' }
  const next = String(newPassword ?? '')
  if (next.length < 6) return { success: false, error: '新密码长度至少 6 位' }
  setSettingValue(role, 'password_hash', sha256(next))
  return { success: true }
}

/** 校验会话是否属于允许的角色之一，否则抛错（IPC 统一入口） */
export function requireRole(allowed: Role[]): Role {
  const role = session?.role
  if (!role) throw new Error('未登录，请先选择角色登录')
  if (!allowed.includes(role)) {
    throw new Error(`当前角色（${roleLabel(role)}）无权执行此操作`)
  }
  return role
}

/** 角色中文名 */
export function roleLabel(role: Role): string {
  return { academic: '教务', finance: '财务', assistant: '助教' }[role]
}

/** 持久化会话到 auth.json */
function persist(): void {
  try {
    if (!authFilePath) return
    fs.writeFileSync(authFilePath, JSON.stringify(session), 'utf8')
  } catch {
    /* 写入失败不影响本次会话 */
  }
}

/** 供 db 层测试/迁移使用：确认三个角色的密码哈希（登录校验在 auth 层完成） */
export function verifyRolePassword(role: Role, password: string): boolean {
  const hash = getSettingValue(role, 'password_hash')
  return !!hash && sha256(String(password ?? '')) === hash
}

/** 获取角色数据库引用（便捷封装，供跨库只读访问） */
export function roleDb(role: Role): ReturnType<typeof getDb> {
  return getDb(role)
}
