/**
 * 多校区信息同步引擎（v3）。
 *
 * 同步模型：人工同步包（导出文件 → 微信/邮件发送 → 对方导入）。
 * - 范围：教务库（课程/老师/学生/排课/考勤/设置）+ 助教库（课程内容记录）；
 *   财务库永不参与同步（校区财务数据保持本地）。
 * - 包内容：全量快照 + 删除墓碑，每次导出都是完整包 → 导入幂等、顺序无关。
 * - 合并规则：
 *   1) 同一来源（sync_origin 相同）的同一行 → 最近修改优先（updated_at 大者胜）；
 *   2) 两个校区各自创建了相同 id 的不同行 → 保留双方数据，导入方为新校区行
 *      分配新 id 并重建引用（sync_remote_id 记录来源 id，用于后续定位）；
 *   3) 删除墓碑：来源一致且墓碑时间晚于本地行修改时间 → 本地删除（级联生效）。
 * - 排除项：password_hash、ai_api_key 不进入同步包（密码与 API 密钥各校区自管）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { format } from 'date-fns'
import { getDb, Role } from './db'

// ---------------------------------------------------------------------------
// 校区身份与同步历史（存于数据目录 JSON 文件，与角色库无关）
// ---------------------------------------------------------------------------

let dataDir = ''

interface CampusConfig {
  campusId: string
  campusName: string
}

export interface SyncHistoryEntry {
  type: 'export' | 'import'
  ts: string
  campusName: string
  counts?: string
  path?: string
}

/** 初始化（main 启动时调用，与 initDatabases 同目录） */
export function initSync(dir: string): void {
  dataDir = dir
  const cfgPath = path.join(dir, 'sync.json')
  if (!fs.existsSync(cfgPath)) {
    const cfg: CampusConfig = { campusId: crypto.randomUUID(), campusName: '' }
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8')
  }
}

function readConfig(): CampusConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'sync.json'), 'utf8')) as Partial<CampusConfig>
  return { campusId: raw.campusId || crypto.randomUUID(), campusName: raw.campusName ?? '' }
}

function writeConfig(cfg: CampusConfig): void {
  fs.writeFileSync(path.join(dataDir, 'sync.json'), JSON.stringify(cfg, null, 2), 'utf8')
}

export function getCampusId(): string {
  return readConfig().campusId
}

export function getCampusInfo(): CampusConfig {
  return readConfig()
}

export function setCampusName(name: string): CampusConfig {
  const cfg = readConfig()
  cfg.campusName = String(name ?? '').trim().slice(0, 30)
  writeConfig(cfg)
  return cfg
}

export function getSyncHistory(): SyncHistoryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'sync-history.json'), 'utf8')) as SyncHistoryEntry[]
  } catch {
    return []
  }
}

function addHistory(entry: SyncHistoryEntry): void {
  const list = getSyncHistory()
  list.unshift(entry)
  fs.writeFileSync(path.join(dataDir, 'sync-history.json'), JSON.stringify(list.slice(0, 50), null, 2), 'utf8')
}

/** 把本机存量数据标记为本地校区来源（幂等，首次同步前调用；财务库不参与同步） */
export function backfillSyncOrigin(): void {
  const campus = readConfig().campusId
  const tables: Record<Role, string[]> = {
    academic: ['teachers', 'students', 'courses', 'teacher_courses', 'student_courses', 'schedule_instances', 'attendances'],
    finance: [],
    assistant: ['lesson_notes']
  }
  for (const role of ['academic', 'assistant'] as Role[]) {
    const db = getDb(role)
    for (const t of tables[role]) {
      db.prepare(`UPDATE "${t}" SET sync_origin = ? WHERE sync_origin IS NULL`).run(campus)
    }
    db.prepare(`UPDATE sync_tombstones SET sync_origin = ? WHERE sync_origin IS NULL`).run(campus)
  }
}

// ---------------------------------------------------------------------------
// 同步包结构
// ---------------------------------------------------------------------------

export interface SyncPackage {
  version: number
  campusId: string
  campusName: string
  exportedAt: string
  academic: { tables: Record<string, Record<string, unknown>[]>; tombstones: Record<string, unknown>[] }
  assistant: { tables: Record<string, Record<string, unknown>[]>; tombstones: Record<string, unknown>[] }
}

export interface SyncStats {
  added: number
  updated: number
  deleted: number
  remapped: number
  fromCampus: string
}

/** 参与同步的表（顺序即导入依赖顺序：父表在前） */
const ACADEMIC_SYNC_TABLES = [
  'teachers',
  'courses',
  'teacher_courses',
  'students',
  'student_courses',
  'schedule_instances',
  'attendances',
  'settings'
] as const
const ASSISTANT_SYNC_TABLES = ['lesson_notes'] as const

/** 不参与同步的设置键（密码/密钥各校区自管） */
const EXCLUDED_SETTING_KEYS = ['password_hash', 'ai_api_key']

/** 各表主键列（单主键 / 复合键，用于查找与墓碑定位） */
const TABLE_PK: Record<string, string[]> = {
  teachers: ['id'],
  students: ['id'],
  courses: ['id'],
  teacher_courses: ['teacher_id', 'course_id'],
  student_courses: ['student_id', 'course_id'],
  schedule_instances: ['id'],
  attendances: ['schedule_instance_id', 'student_id'],
  settings: ['key'],
  lesson_notes: ['id']
}

/** 各表外键引用（用于 id 重映射后的引用重建） */
const TABLE_REFS: Record<string, { col: string; target: string }[]> = {
  teacher_courses: [
    { col: 'teacher_id', target: 'teachers' },
    { col: 'course_id', target: 'courses' }
  ],
  student_courses: [
    { col: 'student_id', target: 'students' },
    { col: 'course_id', target: 'courses' }
  ],
  schedule_instances: [
    { col: 'course_id', target: 'courses' },
    { col: 'actual_teacher_id', target: 'teachers' }
  ],
  attendances: [
    { col: 'schedule_instance_id', target: 'schedule_instances' },
    { col: 'student_id', target: 'students' }
  ],
  lesson_notes: [{ col: 'schedule_instance_id', target: 'schedule_instances' }]
}

function tableDb(table: string): Role {
  return (ASSISTANT_SYNC_TABLES as readonly string[]).includes(table) ? 'assistant' : 'academic'
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

export function buildSyncPackage(): SyncPackage {
  backfillSyncOrigin()
  const cfg = readConfig()
  const dump = (role: 'academic' | 'assistant', tables: readonly string[]): SyncPackage['academic'] => {
    const db = getDb(role)
    const out: Record<string, Record<string, unknown>[]> = {}
    for (const t of tables) {
      if (t === 'settings') {
        out[t] = (db.prepare(`SELECT * FROM settings`).all() as Record<string, unknown>[]).filter(
          (r) => !EXCLUDED_SETTING_KEYS.includes(String(r.key))
        )
      } else {
        out[t] = db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[]
      }
    }
    return { tables: out, tombstones: db.prepare('SELECT * FROM sync_tombstones').all() as Record<string, unknown>[] }
  }
  return {
    version: 3,
    campusId: cfg.campusId,
    campusName: cfg.campusName || '未命名校区',
    exportedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
    academic: dump('academic', ACADEMIC_SYNC_TABLES),
    assistant: dump('assistant', ASSISTANT_SYNC_TABLES)
  }
}

export function packageRowCount(pkg: SyncPackage): number {
  const count = (part: SyncPackage['academic']): number =>
    Object.values(part.tables).reduce((s, rows) => s + rows.length, 0) + part.tombstones.length
  return count(pkg.academic) + count(pkg.assistant)
}

export function recordExportHistory(pkg: SyncPackage, filePath: string): void {
  addHistory({
    type: 'export',
    ts: pkg.exportedAt,
    campusName: pkg.campusName,
    counts: `共 ${packageRowCount(pkg)} 条记录`,
    path: filePath
  })
}

// ---------------------------------------------------------------------------
// 导入（合并）
// ---------------------------------------------------------------------------

interface ImportContext {
  stats: SyncStats
  /** 单主键表 id 重映射：table → 原id → 新id */
  remap: Map<string, Map<number, number>>
  /** 各表下一个可用 id */
  nextId: Map<string, number>
}

function nextAvailableId(db: ReturnType<typeof getDb>, table: string): number {
  const row = db.prepare(`SELECT MAX(id) AS m FROM "${table}"`).get() as { m: number | null }
  return (row.m ?? 0) + 1
}

/** 单主键表查找本地行：本校区行按 id；跨校区行按 (sync_origin, sync_remote_id) */
function findLocalRow(db: ReturnType<typeof getDb>, table: string, row: Record<string, unknown>): Record<string, unknown> | undefined {
  const origin = String(row.sync_origin ?? '')
  const id = Number(row.id)
  const remoteId = row.sync_remote_id !== null && row.sync_remote_id !== undefined ? Number(row.sync_remote_id) : id
  if (origin === getCampusId()) {
    return db.prepare(`SELECT * FROM "${table}" WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  }
  const byRemote = db
    .prepare(`SELECT * FROM "${table}" WHERE sync_origin = ? AND sync_remote_id = ?`)
    .get(origin, remoteId) as Record<string, unknown> | undefined
  if (byRemote) return byRemote
  // 兼容：无 remote_id 的历史导入行按 (origin, id) 定位
  return db.prepare(`SELECT * FROM "${table}" WHERE sync_origin = ? AND id = ?`).get(origin, id) as
    | Record<string, unknown>
    | undefined
}

/** 合并单主键表 */
function mergeSingleTable(ctx: ImportContext, db: ReturnType<typeof getDb>, table: string, rows: Record<string, unknown>[]): void {
  if (rows.length === 0) return
  const sample = rows[0]
  const cols = Object.keys(sample)
  const insert = db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
  const update = db.prepare(
    `UPDATE "${table}" SET ${cols.filter((c) => c !== 'id').map((c) => `"${c}" = ?`).join(', ')} WHERE id = ?`
  )

  for (const row of rows) {
    const originId = Number(row.sync_remote_id ?? row.id ?? 0)
    const local = findLocalRow(db, table, row)
    if (!local) {
      const id = Number(row.id)
      const idTaken = db.prepare(`SELECT 1 FROM "${table}" WHERE id = ?`).get(id)
      if (!idTaken) {
        insert.run(...cols.map((k) => row[k]))
        ctx.stats.added++
      } else {
        // id 冲突（两个校区各自创建的不同行）：保留双方，新行分配新 id
        const newId = ctx.nextId.get(table) ?? nextAvailableId(db, table)
        ctx.nextId.set(table, newId + 1)
        ctx.remap.get(table)?.set(originId, newId)
        insert.run(...cols.map((k) => (k === 'id' ? newId : row[k])))
        db.prepare(`UPDATE "${table}" SET sync_remote_id = ? WHERE id = ?`).run(originId, newId)
        ctx.stats.added++
        ctx.stats.remapped++
      }
      continue
    }
    // 同来源同一行：最近修改优先
    if (String(row.updated_at ?? '') > String(local.updated_at ?? '')) {
      update.run(...cols.filter((c) => c !== 'id').map((k) => row[k]), Number(local.id))
      ctx.stats.updated++
    }
  }
}

/** 合并复合主键表（关联表/考勤：按复合键定位，LWW） */
function mergeCompositeTable(ctx: ImportContext, db: ReturnType<typeof getDb>, table: string, rows: Record<string, unknown>[]): void {
  const pkCols = TABLE_PK[table]
  const refs = TABLE_REFS[table] ?? []
  for (const row of rows) {
    // 引用重写：若父行在本次导入中发生 id 重映射，同步改写本行外键
    const resolved: Record<string, unknown> = { ...row }
    for (const ref of refs) {
      const oldVal = Number(resolved[ref.col])
      if (oldVal) {
        const newVal = ctx.remap.get(ref.target)?.get(oldVal)
        if (newVal !== undefined) resolved[ref.col] = newVal
      }
    }
    const keyVals = pkCols.map((c) => resolved[c])
    const where = pkCols.map((c) => `"${c}" = ?`).join(' AND ')
    const local = db.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...keyVals) as
      | Record<string, unknown>
      | undefined
    if (!local) {
      const cols = Object.keys(resolved)
      db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
        ...cols.map((k) => resolved[k])
      )
      ctx.stats.added++
      continue
    }
    if (String(resolved.updated_at ?? '') > String(local.updated_at ?? '')) {
      const rest = Object.keys(resolved).filter((k) => !pkCols.includes(k))
      db.prepare(`UPDATE "${table}" SET ${rest.map((c) => `"${c}" = ?`).join(', ')} WHERE ${where}`).run(
        ...rest.map((k) => resolved[k]),
        ...keyVals
      )
      ctx.stats.updated++
    }
  }
}

/** 应用删除墓碑（含墓碑自身的合并传播） */
function applyTombstones(ctx: ImportContext, db: ReturnType<typeof getDb>, tombstones: Record<string, unknown>[]): void {
  for (const t of tombstones) {
    const table = String(t.table_name)
    const origin = String(t.sync_origin ?? '')
    const deletedAt = String(t.deleted_at ?? '')
    const pkCols = TABLE_PK[table]
    if (!pkCols) continue
    // 复合键墓碑的 row_id 需先做引用重写（如 "3-5" 中的 3 可能已重映射）
    const parts = String(t.row_id).split('-').map(Number)
    if (parts.length !== pkCols.length) continue
    const resolvedParts = parts.map((p, i) => {
      const ref = (TABLE_REFS[table] ?? []).find((r) => r.col === pkCols[i])
      return ref ? ctx.remap.get(ref.target)?.get(p) ?? p : p
    })
    const where = pkCols.map((c) => `"${c}" = ?`).join(' AND ')
    const local = db.prepare(`SELECT * FROM "${table}" WHERE ${where}`).get(...resolvedParts) as
      | Record<string, unknown>
      | undefined
    if (local) {
      const localOrigin = String(local.sync_origin ?? '')
      // 仅当来源一致且墓碑晚于本地修改时删除（不同校区各自的行互不删除）
      if (localOrigin === origin && deletedAt > String(local.updated_at ?? '')) {
        db.prepare(`DELETE FROM "${table}" WHERE ${where}`).run(...resolvedParts)
        ctx.stats.deleted++
      }
    }
    // 合并墓碑本身，便于向其他校区继续传播删除
    const exist = db
      .prepare('SELECT id FROM sync_tombstones WHERE table_name = ? AND row_id = ? AND sync_origin = ?')
      .get(table, String(t.row_id), origin) as { id: number } | undefined
    if (!exist) {
      db.prepare('INSERT INTO sync_tombstones (table_name, row_id, deleted_at, sync_origin) VALUES (?, ?, ?, ?)').run(
        table,
        String(t.row_id),
        deletedAt,
        origin
      )
    }
  }
}

/** 合并同步包（分库事务；返回统计） */
export function mergeSyncPackage(pkg: SyncPackage): SyncStats {
  backfillSyncOrigin()
  const ctx: ImportContext = {
    stats: { added: 0, updated: 0, deleted: 0, remapped: 0, fromCampus: pkg.campusName || pkg.campusId },
    remap: new Map(),
    nextId: new Map()
  }
  for (const t of ['teachers', 'courses', 'students', 'schedule_instances', 'lesson_notes']) {
    ctx.remap.set(t, new Map())
    ctx.nextId.set(t, nextAvailableId(getDb(tableDb(t)), t))
  }

  const mergeAcademic = getDb('academic').transaction(() => {
    for (const t of ACADEMIC_SYNC_TABLES) {
      const rows = pkg.academic.tables[t] ?? []
      if (t === 'settings') {
        for (const row of rows) {
          if (EXCLUDED_SETTING_KEYS.includes(String(row.key))) continue
          getDb('academic')
            .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(String(row.key), String(row.value))
        }
        continue
      }
      if (TABLE_PK[t].length === 1) mergeSingleTable(ctx, getDb('academic'), t, rows)
      else mergeCompositeTable(ctx, getDb('academic'), t, rows)
    }
    applyTombstones(ctx, getDb('academic'), pkg.academic.tombstones as Record<string, unknown>[])
  })
  mergeAcademic()

  const mergeAssistant = getDb('assistant').transaction(() => {
    for (const t of ASSISTANT_SYNC_TABLES) {
      const rows = pkg.assistant.tables[t] ?? []
      if (TABLE_PK[t].length === 1) mergeSingleTable(ctx, getDb('assistant'), t, rows)
      else mergeCompositeTable(ctx, getDb('assistant'), t, rows)
    }
    applyTombstones(ctx, getDb('assistant'), pkg.assistant.tombstones as Record<string, unknown>[])
  })
  mergeAssistant()

  addHistory({
    type: 'import',
    ts: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
    campusName: ctx.stats.fromCampus,
    counts: `新增 ${ctx.stats.added} / 更新 ${ctx.stats.updated} / 删除 ${ctx.stats.deleted}${ctx.stats.remapped > 0 ? ` / 重映射 ${ctx.stats.remapped}` : ''}`
  })
  return ctx.stats
}
