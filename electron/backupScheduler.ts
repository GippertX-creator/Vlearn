/**
 * 定时备份调度器（v4）：
 * - 每周自动备份一次（默认周日晚 03:00，可在设置中配置），
 *   应用启动时检查：若超过一个备份周期未备份则立即补备份。
 * - 备份内容：三个角色数据库（使用 better-sqlite3 在线备份 API，WAL 安全），
 *   不包含配置文件与密钥。
 * - 保留最近 N 份（默认 4 份，可配置），自动清理更旧的备份。
 * - 备份结果写入系统通知（system-notifications.json），渲染层侧边栏展示。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { format } from 'date-fns'
import { getDb, getSettingValue, Role, setSettingValue } from './db'

let dataDir = ''
let timer: NodeJS.Timeout | null = null

export interface BackupConfig {
  enabled: boolean
  dir: string
  /** 星期几备份：0=周日 … 6=周六 */
  day: number
  /** 备份小时（0-23） */
  hour: number
  /** 保留份数 */
  keep: number
  lastBackupTime: string | null
  lastBackupStatus: string | null
}

export interface BackupResult {
  success: boolean
  files?: string[]
  error?: string
}


/** 备份配置存于教务库 settings（三库共享该配置，由主进程统一读写） */
export function getBackupConfig(): BackupConfig {
  const defaultDir = path.join(dataDir, 'VlearnBackups')
  return {
    enabled: (getSettingValue('academic', 'backup_enabled') ?? '1') === '1',
    dir: getSettingValue('academic', 'backup_dir') ?? defaultDir,
    day: parseInt(getSettingValue('academic', 'backup_day') ?? '0', 10) || 0,
    hour: parseInt(getSettingValue('academic', 'backup_hour') ?? '3', 10) || 3,
    keep: Math.max(1, Math.min(52, parseInt(getSettingValue('academic', 'backup_keep') ?? '4', 10) || 4)),
    lastBackupTime: getSettingValue('academic', 'last_backup_time'),
    lastBackupStatus: getSettingValue('academic', 'last_backup_status')
  }
}

export function saveBackupConfig(cfg: { enabled: boolean; dir: string; day: number; hour: number; keep: number }): void {
  const dir = String(cfg.dir ?? '').trim()
  if (!dir) throw new Error('备份目录不能为空')
  setSettingValue('academic', 'backup_enabled', cfg.enabled ? '1' : '0')
  setSettingValue('academic', 'backup_dir', dir)
  setSettingValue('academic', 'backup_day', String(Math.max(0, Math.min(6, Number(cfg.day) || 0))))
  setSettingValue('academic', 'backup_hour', String(Math.max(0, Math.min(23, Number(cfg.hour) || 3))))
  setSettingValue('academic', 'backup_keep', String(Math.max(1, Math.min(52, Number(cfg.keep) || 4))))
}

/** 执行一次备份（异步，不阻塞主界面） */
export async function runBackup(): Promise<BackupResult> {
  const cfg = getBackupConfig()
  try {
    fs.mkdirSync(cfg.dir, { recursive: true })
    const stamp = format(new Date(), 'yyyyMMdd_HHmmss')
    const roleNames: Record<Role, string> = { academic: 'vlearn_academic', finance: 'vlearn_finance', assistant: 'vlearn_assistant' }
    const files: string[] = []
    for (const role of Object.keys(roleNames) as Role[]) {
      const target = path.join(cfg.dir, `${roleNames[role]}_${stamp}.db`)
      await getDb(role).backup(target)
      files.push(target)
      pruneBackups(cfg.dir, roleNames[role], cfg.keep)
    }
    setSettingValue('academic', 'last_backup_time', format(new Date(), 'yyyy-MM-dd HH:mm:ss'))
    setSettingValue('academic', 'last_backup_status', 'success')
    pushNotification('success', '自动备份完成', `已备份教务/财务/助教三个数据库到：${cfg.dir}`)
    return { success: true, files }
  } catch (err) {
    const msg = (err as Error).message
    setSettingValue('academic', 'last_backup_status', `失败：${msg}`)
    pushNotification('error', '自动备份失败', `${msg}（请检查备份目录是否可写、磁盘空间是否充足）`)
    return { success: false, error: msg }
  }
}

/** 按前缀保留最近 N 份备份 */
function pruneBackups(dir: string, prefix: string, keep: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(prefix + '_') && f.endsWith('.db'))
      .sort()
    const extra = files.slice(0, Math.max(0, files.length - keep))
    for (const f of extra) {
      try {
        fs.rmSync(path.join(dir, f))
      } catch {
        /* 清理失败忽略 */
      }
    }
  } catch {
    /* 目录不存在等 */
  }
}

/** 是否需要补备份（到期未备份或距上次备份超过 8 天） */
function shouldBackupNow(cfg: BackupConfig, now: Date): boolean {
  if (!cfg.enabled) return false
  if (!cfg.lastBackupTime) return true
  const last = new Date(cfg.lastBackupTime.replace(' ', 'T'))
  const daysSince = (now.getTime() - last.getTime()) / 86400000
  if (daysSince >= 8) return true // 错过一个周期以上 → 补备份
  const today = format(now, 'yyyy-MM-dd')
  const lastDay = format(last, 'yyyy-MM-dd')
  // 到达设定周期日且当天尚未备份
  return now.getDay() === cfg.day && now.getHours() >= cfg.hour && lastDay !== today
}

let backingUp = false

/** 检查并触发备份（幂等，避免并发） */
export function checkBackup(): void {
  const cfg = getBackupConfig()
  if (!shouldBackupNow(cfg, new Date())) return
  if (backingUp) return
  backingUp = true
  runBackup()
    .catch(() => {
      /* 错误已在 runBackup 内记录 */
    })
    .finally(() => {
      backingUp = false
    })
}

/** 初始化：数据目录 + 启动检查 + 每 30 分钟轮询 */
export function initBackupScheduler(dir: string): void {
  dataDir = dir
  if (timer) clearInterval(timer)
  // 启动即检查（补备份场景）
  setTimeout(checkBackup, 5000)
  timer = setInterval(checkBackup, 30 * 60 * 1000)
}

// ---------------------------------------------------------------------------
// 系统通知（备份结果等非 Agent 通知）
// ---------------------------------------------------------------------------

export interface SystemNotification {
  id: string
  ts: string
  level: 'success' | 'error' | 'info'
  title: string
  detail: string
}

function notificationsPath(): string {
  return path.join(dataDir, 'system-notifications.json')
}

export function getSystemNotifications(): SystemNotification[] {
  try {
    return JSON.parse(fs.readFileSync(notificationsPath(), 'utf8')) as SystemNotification[]
  } catch {
    return []
  }
}

export function pushNotification(level: SystemNotification['level'], title: string, detail: string): void {
  const list = getSystemNotifications()
  list.unshift({ id: crypto.randomUUID(), ts: format(new Date(), 'yyyy-MM-dd HH:mm'), level, title, detail })
  try {
    fs.writeFileSync(notificationsPath(), JSON.stringify(list.slice(0, 20), null, 2), 'utf8')
  } catch {
    /* 通知写失败不影响备份 */
  }
}
