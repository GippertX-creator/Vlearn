/**
 * 当前登录角色上下文：页面组件通过 useRole() 感知角色以调整界面。
 * 角色由 App 在登录后写入；未登录时为 null。
 */
import { createContext, useContext } from 'react'
import type { Role } from './types'

export const RoleContext = createContext<Role | null>(null)

/** 获取当前登录角色（未登录返回 null） */
export function useRole(): Role | null {
  return useContext(RoleContext)
}

/** 角色中文名 */
export function roleName(role: Role): string {
  return { academic: '教务', finance: '财务', assistant: '助教' }[role]
}
