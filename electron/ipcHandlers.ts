/**
 * IPC 处理器（v2：三角色物理隔离架构）。
 *
 * 权限模型（主进程强制，渲染进程无法绕过）：
 * - 教务写（课程/老师/学生/排课/考勤变更）        → 仅 academic
 * - 教务读（课程/老师/学生/排课/考勤查询）        → academic / finance / assistant（后两者只读）
 * - 财务全部通道                                → 仅 finance（可读写教务库中课程的 fee/pay_per_session 两列）
 * - 助教全部通道                                → 仅 assistant（lesson_notes / generated_messages 存于助教库）
 * - 登录/登出/状态、备份恢复、Excel 导出          → 任意已登录角色
 *
 * 跨库规则：
 * - 财务计算学生应缴/老师应付时经只读 SQL 查询教务库（students/courses/schedule_instances/attendances），
 *   财务库中的外键引用（student_id/course_id/…）无法声明跨库约束，由本文件在
 *   教务删除课程/学生/老师时同步清理财务库关联记录。
 * - 非财务角色获取课程数据时，fee/pay_per_session 字段在 IPC 边界被清零（完全不可见）。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { format } from 'date-fns'
import type {
  AcademicSettings,
  AgentAlert,
  AnomalyCheckResult,
  AssistantSettings,
  AttendanceStatus,
  AuthStatus,
  ConflictItem,
  Course,
  DashboardData,
  ExcelExportPayload,
  FinanceSettings,
  GeneratedContent,
  GeneratedMessage,
  InstanceDetail,
  LessonNote,
  LoginResult,
  MonthReportRow,
  ReconcileResult,
  Role,
  RoleSettings,
  ScheduleInstance,
  ScheduleRule,
  SlotSuggestion,
  Student,
  StudentDetail,
  StudentPayment,
  Teacher,
  TeacherDetail,
  TeacherPayment
} from '../src/types'
import {
  checkCourseConflict,
  checkDuplicateName,
  checkInstanceConflict,
  checkPaymentAnomaly,
  generateReport,
  getAcademicAlerts,
  getFinanceAlerts,
  reconcile,
  smartReport,
  suggestSlots,
  trendAnalysis
} from './agent'
import { callLLM } from './ai'
import { SMS_SYSTEM_PROMPT } from './prompts'
import {
  buildSyncPackage,
  getCampusId,
  getCampusInfo,
  getSyncHistory,
  mergeSyncPackage,
  packageRowCount,
  recordExportHistory,
  setCampusName,
  SyncPackage,
  SyncStats
} from './sync'
import { changePassword, login, logout, requireRole, roleLabel } from './auth'
import { closeAll, getDb, getDbPath, getMigrationError, getSettingValue, initDatabases, setSettingValue } from './db'
import { buildWorkbook, exportFileName } from './excelExport'
import { generateInstances } from './schedule'

/** 教务读权限：三角色均可 */
function guardAcademicRead(): void {
  requireRole(['academic', 'finance', 'assistant'])
}

// ---------------------------------------------------------------------------
// 多校区同步埋点（v3）
// ---------------------------------------------------------------------------

/** 记录删除墓碑（供同步包传播删除操作；table 决定所在角色库） */
function tombstone(table: string, rowId: string | number): void {
  const db = getDb(table === 'lesson_notes' ? 'assistant' : 'academic')
  db.prepare('INSERT INTO sync_tombstones (table_name, row_id, deleted_at, sync_origin) VALUES (?, ?, ?, ?)').run(
    table,
    String(rowId),
    format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
    getCampusId()
  )
}

/** 当前校区标识（写路径注入 sync_origin） */
function localCampus(): string {
  return getCampusId()
}

// ---------------------------------------------------------------------------
// 行映射工具（snake_case → camelCase；非财务角色屏蔽费用字段）
// ---------------------------------------------------------------------------

interface CourseRow {
  id: number
  subject: string
  grade: string
  class_name: string
  default_teacher_id: number | null
  default_teacher_name: string | null
  default_schedule_rule: string | null
  fee: number
  pay_per_session: number
  created_at: string
  updated_at: string
}

function mapCourse(row: CourseRow, maskFee: boolean): Course {
  let scheduleRule: ScheduleRule[] = []
  try {
    scheduleRule = JSON.parse(row.default_schedule_rule ?? '[]') as ScheduleRule[]
  } catch {
    scheduleRule = []
  }
  return {
    id: row.id,
    subject: row.subject,
    grade: row.grade,
    className: row.class_name,
    defaultTeacherId: row.default_teacher_id,
    defaultTeacherName: row.default_teacher_name,
    scheduleRule,
    // 费用字段仅财务可见：其他角色在 IPC 边界清零
    fee: maskFee ? 0 : row.fee,
    payPerSession: maskFee ? 0 : row.pay_per_session,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

const COURSE_SELECT = `
  SELECT c.*, t.name AS default_teacher_name
  FROM courses c
  LEFT JOIN teachers t ON t.id = c.default_teacher_id
`

function fetchCourse(id: number, maskFee = false): Course | null {
  const row = getDb('academic').prepare(`${COURSE_SELECT} WHERE c.id = ?`).get(id) as CourseRow | undefined
  return row ? mapCourse(row, maskFee) : null
}

/** 课程标签，如 "数学 高一 A1班" */
export function courseLabel(subject: string, grade: string, className: string): string {
  return `${subject} ${grade} ${className}`
}

function relationIds(table: 'teacher_courses' | 'student_courses', ownerCol: string, ownerId: number): number[] {
  const rows = getDb('academic').prepare(`SELECT course_id FROM ${table} WHERE ${ownerCol} = ? ORDER BY course_id`).all(ownerId) as {
    course_id: number
  }[]
  return rows.map((r) => r.course_id)
}

function courseLabelsByIds(ids: number[]): string[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb('academic')
    .prepare(`SELECT subject, grade, class_name FROM courses WHERE id IN (${placeholders}) ORDER BY id`)
    .all(...ids) as { subject: string; grade: string; class_name: string }[]
  return rows.map((r) => courseLabel(r.subject, r.grade, r.class_name))
}

interface InstanceRow {
  id: number
  course_id: number
  date: string
  start_time: string
  end_time: string
  actual_teacher_id: number | null
  status: 'normal' | 'adjusted' | 'cancelled'
  note: string | null
  subject: string
  grade: string
  class_name: string
  default_teacher_name: string | null
  actual_teacher_name: string | null
}

function mapInstance(row: InstanceRow): ScheduleInstance {
  return {
    id: row.id,
    courseId: row.course_id,
    date: row.date,
    startTime: row.start_time,
    endTime: row.end_time,
    actualTeacherId: row.actual_teacher_id,
    actualTeacherName: row.actual_teacher_name,
    status: row.status,
    note: row.note,
    subject: row.subject,
    grade: row.grade,
    className: row.class_name,
    defaultTeacherName: row.default_teacher_name
  }
}

// ---------------------------------------------------------------------------
// 登录与角色设置
// ---------------------------------------------------------------------------

function registerAuthHandlers(): void {
  ipcMain.handle('auth:getStatus', (): AuthStatus => {
    const role = requireRoleSafe()
    return { loggedIn: role !== null, role, migrationError: getMigrationError() }
  })

  ipcMain.handle('auth:login', (_e, role: Role, password: string): LoginResult => {
    if (!['academic', 'finance', 'assistant'].includes(role)) return { success: false, error: '无效的角色' }
    return login(role, password)
  })

  ipcMain.handle('auth:logout', (): void => {
    logout()
  })

  ipcMain.handle('auth:changePassword', (_e, oldPassword: string, newPassword: string): { success: boolean; error?: string } => {
    requireRole(['academic', 'finance', 'assistant'])
    return changePassword(oldPassword, newPassword)
  })
}

/** 未登录返回 null（不抛错，供 auth:getStatus 使用） */
function requireRoleSafe(): Role | null {
  try {
    return requireRole(['academic', 'finance', 'assistant'])
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 课程（写：教务；读：三角色）
// ---------------------------------------------------------------------------

function registerCourseHandlers(): void {
  ipcMain.handle('courses:getAll', (): Course[] => {
    guardAcademicRead()
    const role = requireRole(['academic', 'finance', 'assistant'])
    const rows = getDb('academic').prepare(`${COURSE_SELECT} ORDER BY c.id`).all() as CourseRow[]
    return rows.map((r) => mapCourse(r, role !== 'finance'))
  })

  ipcMain.handle(
    'courses:create',
    (
      _e,
      data: { subject: string; grade: string; className: string; defaultTeacherId: number | null; scheduleRule: ScheduleRule[] }
    ): Course => {
      requireRole(['academic'])
      const subject = String(data.subject ?? '').trim()
      const grade = String(data.grade ?? '').trim()
      const className = String(data.className ?? '').trim()
      if (!subject || !grade || !className) throw new Error('科目、年级、班级号不能为空')
      const result = getDb('academic')
        .prepare(
          `INSERT INTO courses (subject, grade, class_name, default_teacher_id, default_schedule_rule, sync_origin)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(subject, grade, className, data.defaultTeacherId ?? null, JSON.stringify(data.scheduleRule ?? []), localCampus())
      const courseId = Number(result.lastInsertRowid)
      const weeks = parseInt(getSettingValue('academic', 'schedule_weeks') ?? '8', 10) || 8
      generateInstances(getDb('academic'), courseId, data.scheduleRule ?? [], new Date(), weeks, localCampus())
      return fetchCourse(courseId)!
    }
  )

  ipcMain.handle(
    'courses:update',
    (
      _e,
      id: number,
      data: { subject: string; grade: string; className: string; defaultTeacherId: number | null; scheduleRule: ScheduleRule[] }
    ): Course => {
      requireRole(['academic'])
      if (!fetchCourse(id)) throw new Error('课程不存在')
      const subject = String(data.subject ?? '').trim()
      const grade = String(data.grade ?? '').trim()
      const className = String(data.className ?? '').trim()
      if (!subject || !grade || !className) throw new Error('科目、年级、班级号不能为空')
      getDb('academic')
        .prepare(
          `UPDATE courses SET subject = ?, grade = ?, class_name = ?, default_teacher_id = ?, default_schedule_rule = ?,
           updated_at = datetime('now') WHERE id = ?`
        )
        .run(subject, grade, className, data.defaultTeacherId ?? null, JSON.stringify(data.scheduleRule ?? []), id)
      return fetchCourse(id)!
    }
  )

  ipcMain.handle('courses:delete', (_e, id: number): void => {
    requireRole(['academic'])
    // 跨库清理：财务库中与该课程相关的外键引用（外键无法跨库声明）
    const instanceIds = (getDb('academic').prepare('SELECT id FROM schedule_instances WHERE course_id = ?').all(id) as { id: number }[])
      .map((r) => r.id)
    const attendanceIds = instanceIds.length
      ? (getDb('academic')
          .prepare(`SELECT schedule_instance_id, student_id FROM attendances WHERE schedule_instance_id IN (${instanceIds.map(() => '?').join(',')})`)
          .all(...instanceIds) as { schedule_instance_id: number; student_id: number }[])
      : []
    const junctionPairs = [
      ...(getDb('academic').prepare('SELECT teacher_id, course_id FROM teacher_courses WHERE course_id = ?').all(id) as {
        teacher_id: number
        course_id: number
      }[]).map((r) => ({ table: 'teacher_courses', rowId: `${r.teacher_id}-${r.course_id}` })),
      ...(getDb('academic').prepare('SELECT student_id, course_id FROM student_courses WHERE course_id = ?').all(id) as {
        student_id: number
        course_id: number
      }[]).map((r) => ({ table: 'student_courses', rowId: `${r.student_id}-${r.course_id}` }))
    ]
    const tx = getDb('academic').transaction(() => {
      // 同步墓碑：级联删除的实例、考勤、关联关系都需要传播到其他校区
      for (const iid of instanceIds) tombstone('schedule_instances', iid)
      for (const a of attendanceIds) tombstone('attendances', `${a.schedule_instance_id}-${a.student_id}`)
      for (const j of junctionPairs) tombstone(j.table, j.rowId)
      tombstone('courses', id)
      if (instanceIds.length > 0) {
        const placeholders = instanceIds.map(() => '?').join(',')
        getDb('finance').prepare(`DELETE FROM teacher_payments WHERE schedule_instance_id IN (${placeholders})`).run(...instanceIds)
      }
      getDb('finance').prepare('DELETE FROM student_payments WHERE course_id = ?').run(id)
      getDb('academic').prepare('DELETE FROM courses WHERE id = ?').run(id)
    })
    tx()
  })

  ipcMain.handle('courses:regenerate', (_e, courseId: number): number => {
    requireRole(['academic'])
    const course = fetchCourse(courseId)
    if (!course) throw new Error('课程不存在')
    const today = format(new Date(), 'yyyy-MM-dd')
    // 收集将被删除的实例，先清理财务库课酬记录
    const deletedIds = (
      getDb('academic').prepare('SELECT id FROM schedule_instances WHERE course_id = ? AND date >= ?').all(courseId, today) as {
        id: number
      }[]
    ).map((r) => r.id)
    const deletedAttendances = deletedIds.length
      ? (getDb('academic')
          .prepare(`SELECT schedule_instance_id, student_id FROM attendances WHERE schedule_instance_id IN (${deletedIds.map(() => '?').join(',')})`)
          .all(...deletedIds) as { schedule_instance_id: number; student_id: number }[])
      : []
    const tx = getDb('academic').transaction(() => {
      for (const iid of deletedIds) tombstone('schedule_instances', iid)
      for (const a of deletedAttendances) tombstone('attendances', `${a.schedule_instance_id}-${a.student_id}`)
      if (deletedIds.length > 0) {
        const placeholders = deletedIds.map(() => '?').join(',')
        getDb('finance').prepare(`DELETE FROM teacher_payments WHERE schedule_instance_id IN (${placeholders})`).run(...deletedIds)
      }
      getDb('academic').prepare('DELETE FROM schedule_instances WHERE course_id = ? AND date >= ?').run(courseId, today)
    })
    tx()
    const weeks = parseInt(getSettingValue('academic', 'schedule_weeks') ?? '8', 10) || 8
    return generateInstances(getDb('academic'), courseId, course.scheduleRule, new Date(), weeks, localCampus())
  })
}

// ---------------------------------------------------------------------------
// 老师（写：教务；读：三角色）
// ---------------------------------------------------------------------------

function registerTeacherHandlers(): void {
  ipcMain.handle('teachers:getAll', (): Teacher[] => {
    guardAcademicRead()
    const rows = getDb('academic').prepare('SELECT * FROM teachers ORDER BY id').all() as {
      id: number
      name: string
      note: string | null
    }[]
    return rows.map((row) => {
      const courseIds = relationIds('teacher_courses', 'teacher_id', row.id)
      return { id: row.id, name: row.name, note: row.note, courseIds, courseLabels: courseLabelsByIds(courseIds) }
    })
  })

  ipcMain.handle('teachers:getDetail', (_e, id: number): TeacherDetail => {
    guardAcademicRead()
    const row = getDb('academic').prepare('SELECT * FROM teachers WHERE id = ?').get(id) as
      | { id: number; name: string; note: string | null }
      | undefined
    if (!row) throw new Error('老师不存在')
    const courseIds = relationIds('teacher_courses', 'teacher_id', id)
    const teacher: Teacher = {
      id: row.id,
      name: row.name,
      note: row.note,
      courseIds,
      courseLabels: courseLabelsByIds(courseIds)
    }
    const total = getDb('academic')
      .prepare(
        `SELECT COUNT(*) AS c FROM schedule_instances si
         JOIN courses c ON c.id = si.course_id
         WHERE si.actual_teacher_id = ? OR (si.actual_teacher_id IS NULL AND c.default_teacher_id = ?)`
      )
      .get(id, id) as { c: number }
    const upcoming = getDb('academic')
      .prepare(
        `SELECT COUNT(*) AS c FROM schedule_instances si
         JOIN courses c ON c.id = si.course_id
         WHERE (si.actual_teacher_id = ? OR (si.actual_teacher_id IS NULL AND c.default_teacher_id = ?))
         AND si.date >= ? AND si.status != 'cancelled'`
      )
      .get(id, id, format(new Date(), 'yyyy-MM-dd')) as { c: number }
    return { teacher, totalInstances: total.c, upcomingInstances: upcoming.c }
  })

  const replaceTeacherCourses = (teacherId: number, courseIds: number[]): void => {
    const tx = getDb('academic').transaction(() => {
      // 同步墓碑：仅对被移除的关联记录墓碑（新增/保留的不用，避免时间戳边界问题）
      const existing = getDb('academic').prepare('SELECT course_id FROM teacher_courses WHERE teacher_id = ?').all(teacherId) as {
        course_id: number
      }[]
      const nextSet = new Set(courseIds)
      for (const r of existing) {
        if (!nextSet.has(r.course_id)) tombstone('teacher_courses', `${teacherId}-${r.course_id}`)
      }
      getDb('academic').prepare('DELETE FROM teacher_courses WHERE teacher_id = ?').run(teacherId)
      const insert = getDb('academic').prepare(
        `INSERT INTO teacher_courses (teacher_id, course_id, updated_at, sync_origin) VALUES (?, ?, datetime('now'), ?)`
      )
      for (const courseId of courseIds) insert.run(teacherId, courseId, localCampus())
    })
    tx()
  }

  ipcMain.handle('teachers:create', (_e, data: { name: string; note: string | null; courseIds: number[] }): Teacher => {
    requireRole(['academic'])
    const name = String(data.name ?? '').trim()
    if (!name) throw new Error('老师姓名不能为空')
    const result = getDb('academic')
      .prepare(`INSERT INTO teachers (name, note, sync_origin) VALUES (?, ?, ?)`)
      .run(name, data.note ?? null, localCampus())
    const id = Number(result.lastInsertRowid)
    replaceTeacherCourses(id, data.courseIds ?? [])
    return {
      id,
      name,
      note: data.note ?? null,
      courseIds: data.courseIds ?? [],
      courseLabels: courseLabelsByIds(data.courseIds ?? [])
    }
  })

  ipcMain.handle('teachers:update', (_e, id: number, data: { name: string; note: string | null; courseIds: number[] }): Teacher => {
    requireRole(['academic'])
    const name = String(data.name ?? '').trim()
    if (!name) throw new Error('老师姓名不能为空')
    getDb('academic')
      .prepare(`UPDATE teachers SET name = ?, note = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, data.note ?? null, id)
    replaceTeacherCourses(id, data.courseIds ?? [])
    return {
      id,
      name,
      note: data.note ?? null,
      courseIds: data.courseIds ?? [],
      courseLabels: courseLabelsByIds(data.courseIds ?? [])
    }
  })

  ipcMain.handle('teachers:delete', (_e, id: number): void => {
    requireRole(['academic'])
    const junctionPairs = (getDb('academic').prepare('SELECT course_id FROM teacher_courses WHERE teacher_id = ?').all(id) as {
      course_id: number
    }[]).map((r) => ({ table: 'teacher_courses', rowId: `${id}-${r.course_id}` }))
    // 跨库清理财务库课酬记录
    const tx = getDb('academic').transaction(() => {
      tombstone('teachers', id)
      for (const j of junctionPairs) tombstone(j.table, j.rowId)
      getDb('finance').prepare('DELETE FROM teacher_payments WHERE teacher_id = ?').run(id)
      getDb('academic').prepare('DELETE FROM teachers WHERE id = ?').run(id)
    })
    tx()
  })
}

// ---------------------------------------------------------------------------
// 学生（写：教务；读：三角色）
// ---------------------------------------------------------------------------

function registerStudentHandlers(): void {
  ipcMain.handle('students:getAll', (): Student[] => {
    guardAcademicRead()
    const rows = getDb('academic').prepare('SELECT * FROM students ORDER BY id').all() as {
      id: number
      name: string
      school_class: string | null
      note: string | null
    }[]
    return rows.map((row) => {
      const courseIds = relationIds('student_courses', 'student_id', row.id)
      return {
        id: row.id,
        name: row.name,
        schoolClass: row.school_class,
        note: row.note,
        courseIds,
        courseLabels: courseLabelsByIds(courseIds)
      }
    })
  })

  ipcMain.handle('students:getDetail', (_e, id: number): StudentDetail => {
    guardAcademicRead()
    const row = getDb('academic').prepare('SELECT * FROM students WHERE id = ?').get(id) as
      | { id: number; name: string; school_class: string | null; note: string | null }
      | undefined
    if (!row) throw new Error('学生不存在')
    const courseIds = relationIds('student_courses', 'student_id', id)
    const student: Student = {
      id: row.id,
      name: row.name,
      schoolClass: row.school_class,
      note: row.note,
      courseIds,
      courseLabels: courseLabelsByIds(courseIds)
    }
    const attendances = getDb('academic')
      .prepare(
        `SELECT a.id, a.status, a.note, si.date, si.start_time, si.end_time, si.course_id,
                c.subject, c.grade, c.class_name,
                COALESCE(act.name, def.name) AS teacher_name
         FROM attendances a
         JOIN schedule_instances si ON si.id = a.schedule_instance_id
         JOIN courses c ON c.id = si.course_id
         LEFT JOIN teachers def ON def.id = c.default_teacher_id
         LEFT JOIN teachers act ON act.id = si.actual_teacher_id
         WHERE a.student_id = ?
         ORDER BY si.date DESC, si.start_time DESC`
      )
      .all(id) as {
      id: number
      status: AttendanceStatus
      note: string | null
      date: string
      start_time: string
      end_time: string
      course_id: number
      subject: string
      grade: string
      class_name: string
      teacher_name: string | null
    }[]
    const stats = { present: 0, leave: 0, absent: 0 }
    for (const a of attendances) stats[a.status]++
    return {
      student,
      attendances: attendances.map((a) => ({
        id: a.id,
        status: a.status,
        note: a.note,
        date: a.date,
        startTime: a.start_time,
        endTime: a.end_time,
        courseId: a.course_id,
        subject: a.subject,
        grade: a.grade,
        className: a.class_name,
        teacherName: a.teacher_name
      })),
      stats
    }
  })

  const replaceStudentCourses = (studentId: number, courseIds: number[]): void => {
    const tx = getDb('academic').transaction(() => {
      // 同步墓碑：仅对被移除的关联记录墓碑
      const existing = getDb('academic').prepare('SELECT course_id FROM student_courses WHERE student_id = ?').all(studentId) as {
        course_id: number
      }[]
      const nextSet = new Set(courseIds)
      for (const r of existing) {
        if (!nextSet.has(r.course_id)) tombstone('student_courses', `${studentId}-${r.course_id}`)
      }
      getDb('academic').prepare('DELETE FROM student_courses WHERE student_id = ?').run(studentId)
      const insert = getDb('academic').prepare(
        `INSERT INTO student_courses (student_id, course_id, updated_at, sync_origin) VALUES (?, ?, datetime('now'), ?)`
      )
      for (const courseId of courseIds) insert.run(studentId, courseId, localCampus())
    })
    tx()
  }

  ipcMain.handle(
    'students:create',
    (_e, data: { name: string; schoolClass: string | null; note: string | null; courseIds: number[] }): Student => {
      requireRole(['academic'])
      const name = String(data.name ?? '').trim()
      if (!name) throw new Error('学生姓名不能为空')
      const result = getDb('academic')
        .prepare(`INSERT INTO students (name, school_class, note, sync_origin) VALUES (?, ?, ?, ?)`)
        .run(name, data.schoolClass ?? null, data.note ?? null, localCampus())
      const id = Number(result.lastInsertRowid)
      replaceStudentCourses(id, data.courseIds ?? [])
      return {
        id,
        name,
        schoolClass: data.schoolClass ?? null,
        note: data.note ?? null,
        courseIds: data.courseIds ?? [],
        courseLabels: courseLabelsByIds(data.courseIds ?? [])
      }
    }
  )

  ipcMain.handle(
    'students:update',
    (_e, id: number, data: { name: string; schoolClass: string | null; note: string | null; courseIds: number[] }): Student => {
      requireRole(['academic'])
      const name = String(data.name ?? '').trim()
      if (!name) throw new Error('学生姓名不能为空')
      getDb('academic')
        .prepare(`UPDATE students SET name = ?, school_class = ?, note = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(name, data.schoolClass ?? null, data.note ?? null, id)
      replaceStudentCourses(id, data.courseIds ?? [])
      return {
        id,
        name,
        schoolClass: data.schoolClass ?? null,
        note: data.note ?? null,
        courseIds: data.courseIds ?? [],
        courseLabels: courseLabelsByIds(data.courseIds ?? [])
      }
    }
  )

  ipcMain.handle('students:delete', (_e, id: number): void => {
    requireRole(['academic'])
    const junctionPairs = (getDb('academic').prepare('SELECT course_id FROM student_courses WHERE student_id = ?').all(id) as {
      course_id: number
    }[]).map((r) => ({ table: 'student_courses', rowId: `${id}-${r.course_id}` }))
    const attendanceIds = (getDb('academic')
      .prepare('SELECT schedule_instance_id FROM attendances WHERE student_id = ?')
      .all(id) as { schedule_instance_id: number }[]).map((r) => r.schedule_instance_id)
    // 跨库清理财务库缴费记录
    const tx = getDb('academic').transaction(() => {
      tombstone('students', id)
      for (const j of junctionPairs) tombstone(j.table, j.rowId)
      for (const iid of attendanceIds) tombstone('attendances', `${iid}-${id}`)
      getDb('finance').prepare('DELETE FROM student_payments WHERE student_id = ?').run(id)
      getDb('academic').prepare('DELETE FROM students WHERE id = ?').run(id)
    })
    tx()
  })
}

// ---------------------------------------------------------------------------
// 课程实例与考勤
// ---------------------------------------------------------------------------

function registerInstanceHandlers(): void {
  ipcMain.handle('instances:getRange', (_e, start: string, end: string): ScheduleInstance[] => {
    guardAcademicRead()
    const rows = getDb('academic')
      .prepare(
        `SELECT si.*, c.subject, c.grade, c.class_name,
                def.name AS default_teacher_name, act.name AS actual_teacher_name
         FROM schedule_instances si
         JOIN courses c ON c.id = si.course_id
         LEFT JOIN teachers def ON def.id = c.default_teacher_id
         LEFT JOIN teachers act ON act.id = si.actual_teacher_id
         WHERE si.date BETWEEN ? AND ?
         ORDER BY si.date, si.start_time, si.id`
      )
      .all(start, end) as InstanceRow[]
    return rows.map(mapInstance)
  })

  ipcMain.handle('instances:getDetail', (_e, id: number): InstanceDetail => {
    guardAcademicRead()
    const role = requireRole(['academic', 'finance', 'assistant'])
    const row = getDb('academic')
      .prepare(
        `SELECT si.*, c.subject, c.grade, c.class_name,
                def.name AS default_teacher_name, act.name AS actual_teacher_name
         FROM schedule_instances si
         JOIN courses c ON c.id = si.course_id
         LEFT JOIN teachers def ON def.id = c.default_teacher_id
         LEFT JOIN teachers act ON act.id = si.actual_teacher_id
         WHERE si.id = ?`
      )
      .get(id) as InstanceRow | undefined
    if (!row) throw new Error('课程实例不存在')
    const course = fetchCourse(row.course_id, role !== 'finance')!
    const students = getDb('academic')
      .prepare(
        `SELECT s.id, s.name, s.school_class, a.status AS attendance_status
         FROM student_courses sc
         JOIN students s ON s.id = sc.student_id
         LEFT JOIN attendances a ON a.student_id = sc.student_id AND a.schedule_instance_id = ?
         WHERE sc.course_id = ?
         ORDER BY s.name`
      )
      .all(id, row.course_id) as {
      id: number
      name: string
      school_class: string | null
      attendance_status: AttendanceStatus | null
    }[]
    return {
      instance: mapInstance(row),
      course,
      students: students.map((s) => ({
        id: s.id,
        name: s.name,
        schoolClass: s.school_class,
        attendanceStatus: s.attendance_status
      }))
    }
  })

  ipcMain.handle(
    'instances:update',
    (
      _e,
      id: number,
      data: { date: string; startTime: string; endTime: string; actualTeacherId: number | null; note: string | null }
    ): ScheduleInstance => {
      requireRole(['academic'])
      if (!data.date || !data.startTime || !data.endTime) throw new Error('日期与时间不能为空')
      getDb('academic')
        .prepare(
          `UPDATE schedule_instances
           SET date = ?, start_time = ?, end_time = ?, actual_teacher_id = ?, note = ?, status = 'adjusted',
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(data.date, data.startTime, data.endTime, data.actualTeacherId ?? null, data.note ?? null, id)
      const row = getDb('academic')
        .prepare(
          `SELECT si.*, c.subject, c.grade, c.class_name,
                  def.name AS default_teacher_name, act.name AS actual_teacher_name
           FROM schedule_instances si
           JOIN courses c ON c.id = si.course_id
           LEFT JOIN teachers def ON def.id = c.default_teacher_id
           LEFT JOIN teachers act ON act.id = si.actual_teacher_id
           WHERE si.id = ?`
        )
        .get(id) as InstanceRow
      return mapInstance(row)
    }
  )

  ipcMain.handle('instances:cancel', (_e, id: number): void => {
    requireRole(['academic'])
    getDb('academic')
      .prepare(`UPDATE schedule_instances SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`)
      .run(id)
  })

  ipcMain.handle('instances:restore', (_e, id: number): void => {
    requireRole(['academic'])
    getDb('academic')
      .prepare(`UPDATE schedule_instances SET status = 'normal', updated_at = datetime('now') WHERE id = ?`)
      .run(id)
  })

  ipcMain.handle(
    'attendance:save',
    (_e, data: { scheduleInstanceId: number; studentId: number; status: AttendanceStatus; note?: string | null }): void => {
      requireRole(['academic'])
      if (!['present', 'leave', 'absent'].includes(data.status)) throw new Error('无效的考勤状态')
      getDb('academic')
        .prepare(
          `INSERT INTO attendances (schedule_instance_id, student_id, status, note, sync_origin)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(schedule_instance_id, student_id)
           DO UPDATE SET status = excluded.status, note = excluded.note,
                         updated_at = datetime('now'), sync_origin = excluded.sync_origin`
        )
        .run(data.scheduleInstanceId, data.studentId, data.status, data.note ?? null, localCampus())
    }
  )

  ipcMain.handle('attendance:remove', (_e, data: { scheduleInstanceId: number; studentId: number }): void => {
    requireRole(['academic'])
    tombstone('attendances', `${data.scheduleInstanceId}-${data.studentId}`)
    getDb('academic')
      .prepare('DELETE FROM attendances WHERE schedule_instance_id = ? AND student_id = ?')
      .run(data.scheduleInstanceId, data.studentId)
  })

  ipcMain.handle('attendance:markAllPresent', (_e, scheduleInstanceId: number): number => {
    requireRole(['academic'])
    const instance = getDb('academic')
      .prepare('SELECT course_id FROM schedule_instances WHERE id = ?')
      .get(scheduleInstanceId) as { course_id: number } | undefined
    if (!instance) throw new Error('课程实例不存在')
    const result = getDb('academic')
      .prepare(
        `INSERT INTO attendances (schedule_instance_id, student_id, status, sync_origin)
         SELECT ?, sc.student_id, 'present', ? FROM student_courses sc WHERE sc.course_id = ?
         ON CONFLICT(schedule_instance_id, student_id) DO UPDATE SET status = 'present',
                         updated_at = datetime('now'), sync_origin = excluded.sync_origin`
      )
      .run(scheduleInstanceId, localCampus(), instance.course_id)
    return result.changes
  })
}

// ---------------------------------------------------------------------------
// 财务（仅 finance 角色；读教务库做只读计算）
// ---------------------------------------------------------------------------

function registerFinanceHandlers(): void {
  const guard = (): void => {
    requireRole(['finance'])
  }

  ipcMain.handle('finance:getDashboard', (_e, month: string): DashboardData => {
    guard()
    const m = String(month ?? '')
    if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('月份格式应为 YYYY-MM')
    const sum = (sql: string): number => {
      const row = getDb('finance').prepare(sql).get(m) as { s: number } | undefined
      return row?.s ?? 0
    }
    const studentDue = sum(`SELECT COALESCE(SUM(amount_due), 0) AS s FROM student_payments WHERE substr(payment_date, 1, 7) = ?`)
    const studentPaid = sum(`SELECT COALESCE(SUM(amount_paid), 0) AS s FROM student_payments WHERE substr(payment_date, 1, 7) = ?`)
    const teacherDue = sum(`SELECT COALESCE(SUM(amount_due), 0) AS s FROM teacher_payments WHERE substr(payment_date, 1, 7) = ?`)
    const teacherPaid = sum(`SELECT COALESCE(SUM(amount_paid), 0) AS s FROM teacher_payments WHERE substr(payment_date, 1, 7) = ?`)
    return { studentDue, studentPaid, teacherDue, teacherPaid, profit: studentPaid - teacherPaid }
  })

  ipcMain.handle('finance:getCourses', (): Course[] => {
    guard()
    const rows = getDb('academic').prepare(`${COURSE_SELECT} ORDER BY c.id`).all() as CourseRow[]
    return rows.map((r) => mapCourse(r, false))
  })

  ipcMain.handle('finance:updateCourseFees', (_e, id: number, data: { fee: number; payPerSession: number }): Course => {
    guard()
    // 权限矩阵允许财务读写教务库课程的 fee/pay_per_session 两列（唯一例外）
    getDb('academic')
      .prepare(`UPDATE courses SET fee = ?, pay_per_session = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(Number(data.fee) || 0, Number(data.payPerSession) || 0, id)
    return fetchCourse(id, false)!
  })

  // ---------- 学生缴费 ----------

  ipcMain.handle('finance:getStudentPayments', (): StudentPayment[] => {
    guard()
    const rows = getDb('finance')
      .prepare('SELECT * FROM student_payments ORDER BY payment_date DESC, id DESC')
      .all() as {
      id: number
      student_id: number
      course_id: number
      amount_due: number
      amount_paid: number
      payment_method: string
      payment_date: string
      note: string | null
    }[]
    return rows.map((r) => {
      const student = getDb('academic').prepare('SELECT name FROM students WHERE id = ?').get(r.student_id) as
        | { name: string }
        | undefined
      const course = getDb('academic')
        .prepare('SELECT subject, grade, class_name FROM courses WHERE id = ?')
        .get(r.course_id) as { subject: string; grade: string; class_name: string } | undefined
      return {
        id: r.id,
        studentId: r.student_id,
        courseId: r.course_id,
        amountDue: r.amount_due,
        amountPaid: r.amount_paid,
        paymentMethod: r.payment_method,
        paymentDate: r.payment_date,
        note: r.note,
        studentName: student?.name ?? `学生#${r.student_id}`,
        courseLabel: course ? courseLabel(course.subject, course.grade, course.class_name) : `课程#${r.course_id}`
      }
    })
  })

  const insertStudentPayment = (data: {
    studentId: number
    courseId: number
    amountDue: number
    amountPaid: number
    paymentMethod: string
    paymentDate: string
    note: string | null
  }): void => {
    if (!data.studentId || !data.courseId || !data.paymentDate) throw new Error('学生、课程、缴费日期不能为空')
    getDb('finance')
      .prepare(
        `INSERT INTO student_payments (student_id, course_id, amount_due, amount_paid, payment_method, payment_date, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(data.studentId, data.courseId, Number(data.amountDue) || 0, Number(data.amountPaid) || 0, data.paymentMethod || '现金', data.paymentDate, data.note ?? null)
  }

  ipcMain.handle('finance:createStudentPayment', (_e, data: Parameters<typeof insertStudentPayment>[0]): void => {
    guard()
    insertStudentPayment(data)
  })

  ipcMain.handle(
    'finance:updateStudentPayment',
    (
      _e,
      id: number,
      data: {
        studentId: number
        courseId: number
        amountDue: number
        amountPaid: number
        paymentMethod: string
        paymentDate: string
        note: string | null
      }
    ): void => {
      guard()
      if (!data.studentId || !data.courseId || !data.paymentDate) throw new Error('学生、课程、缴费日期不能为空')
      getDb('finance')
        .prepare(
          `UPDATE student_payments
           SET student_id = ?, course_id = ?, amount_due = ?, amount_paid = ?, payment_method = ?, payment_date = ?, note = ?,
               edits_count = edits_count + 1
           WHERE id = ?`
        )
        .run(data.studentId, data.courseId, Number(data.amountDue) || 0, Number(data.amountPaid) || 0, data.paymentMethod || '现金', data.paymentDate, data.note ?? null, id)
    }
  )

  ipcMain.handle('finance:deleteStudentPayment', (_e, id: number): void => {
    guard()
    getDb('finance').prepare('DELETE FROM student_payments WHERE id = ?').run(id)
  })

  ipcMain.handle('finance:autoCalcStudentPayments', (): number => {
    guard()
    // 应缴 = 课程费用 × 计费出勤次数（出勤必计费、请假免费、缺勤按财务设置）
    // 课程费用与考勤均为教务库只读数据
    const chargeAbsent = (getSettingValue('finance', 'charge_absent') ?? '1') === '1'
    const statuses = chargeAbsent ? "('present','absent')" : "('present')"
    const pairs = getDb('academic')
      .prepare(
        `SELECT sc.student_id, sc.course_id, COUNT(a.id) AS cnt, c.fee
         FROM student_courses sc
         JOIN courses c ON c.id = sc.course_id
         LEFT JOIN attendances a ON a.student_id = sc.student_id
           AND a.schedule_instance_id IN (
             SELECT si.id FROM schedule_instances si
             WHERE si.course_id = sc.course_id AND si.status != 'cancelled'
           )
           AND a.status IN ${statuses}
         GROUP BY sc.student_id, sc.course_id`
      )
      .all() as { student_id: number; course_id: number; cnt: number; fee: number }[]

    const upsert = getDb('finance').prepare(
      `INSERT INTO student_payments (student_id, course_id, amount_due, amount_paid, payment_method, payment_date, note)
       VALUES (?, ?, ?, 0, ?, ?, '自动计算应缴')`
    )
    const updateDue = getDb('finance').prepare('UPDATE student_payments SET amount_due = ? WHERE student_id = ? AND course_id = ?')
    const today = format(new Date(), 'yyyy-MM-dd')
    const firstMethod = (JSON.parse(getSettingValue('finance', 'payment_methods') ?? '["现金"]') as string[])[0] ?? '现金'
    const tx = getDb('finance').transaction(() => {
      let count = 0
      for (const p of pairs) {
        const existing = getDb('finance')
          .prepare('SELECT id FROM student_payments WHERE student_id = ? AND course_id = ?')
          .get(p.student_id, p.course_id) as { id: number } | undefined
        const due = Math.round(p.cnt * p.fee * 100) / 100
        if (existing) updateDue.run(due, p.student_id, p.course_id)
        else upsert.run(p.student_id, p.course_id, due, firstMethod, today)
        count++
      }
      return count
    })
    return tx()
  })

  // ---------- 老师课酬 ----------

  ipcMain.handle('finance:getTeacherPayments', (): TeacherPayment[] => {
    guard()
    const rows = getDb('finance')
      .prepare('SELECT * FROM teacher_payments ORDER BY payment_date DESC, id DESC')
      .all() as {
      id: number
      teacher_id: number
      schedule_instance_id: number
      amount_due: number
      amount_paid: number
      payment_date: string
      note: string | null
    }[]
    return rows.map((r) => {
      const teacher = getDb('academic').prepare('SELECT name FROM teachers WHERE id = ?').get(r.teacher_id) as
        | { name: string }
        | undefined
      const si = getDb('academic')
        .prepare(
          `SELECT si.date, si.start_time, si.end_time, c.subject, c.grade, c.class_name
           FROM schedule_instances si JOIN courses c ON c.id = si.course_id WHERE si.id = ?`
        )
        .get(r.schedule_instance_id) as
        | { date: string; start_time: string; end_time: string; subject: string; grade: string; class_name: string }
        | undefined
      return {
        id: r.id,
        teacherId: r.teacher_id,
        scheduleInstanceId: r.schedule_instance_id,
        amountDue: r.amount_due,
        amountPaid: r.amount_paid,
        paymentDate: r.payment_date,
        note: r.note,
        teacherName: teacher?.name ?? `老师#${r.teacher_id}`,
        instanceLabel: si
          ? `${si.date} ${courseLabel(si.subject, si.grade, si.class_name)} ${si.start_time}-${si.end_time}`
          : `课次#${r.schedule_instance_id}`
      }
    })
  })

  ipcMain.handle(
    'finance:createTeacherPayment',
    (
      _e,
      data: { teacherId: number; scheduleInstanceId: number; amountDue: number; amountPaid: number; paymentDate: string; note: string | null }
    ): void => {
      guard()
      if (!data.teacherId || !data.scheduleInstanceId || !data.paymentDate) throw new Error('老师、课程实例、支付日期不能为空')
      getDb('finance')
        .prepare(
          `INSERT INTO teacher_payments (teacher_id, schedule_instance_id, amount_due, amount_paid, payment_date, note)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(data.teacherId, data.scheduleInstanceId, Number(data.amountDue) || 0, Number(data.amountPaid) || 0, data.paymentDate, data.note ?? null)
    }
  )

  ipcMain.handle(
    'finance:updateTeacherPayment',
    (
      _e,
      id: number,
      data: { teacherId: number; scheduleInstanceId: number; amountDue: number; amountPaid: number; paymentDate: string; note: string | null }
    ): void => {
      guard()
      if (!data.teacherId || !data.scheduleInstanceId || !data.paymentDate) throw new Error('老师、课程实例、支付日期不能为空')
      getDb('finance')
        .prepare(
          `UPDATE teacher_payments
           SET teacher_id = ?, schedule_instance_id = ?, amount_due = ?, amount_paid = ?, payment_date = ?, note = ?,
               edits_count = edits_count + 1
           WHERE id = ?`
        )
        .run(data.teacherId, data.scheduleInstanceId, Number(data.amountDue) || 0, Number(data.amountPaid) || 0, data.paymentDate, data.note ?? null, id)
    }
  )

  ipcMain.handle('finance:deleteTeacherPayment', (_e, id: number): void => {
    guard()
    getDb('finance').prepare('DELETE FROM teacher_payments WHERE id = ?').run(id)
  })

  ipcMain.handle('finance:autoCalcTeacherPayments', (): number => {
    guard()
    // 应付 = 课程单次课酬标准；代课场景支付给代课老师（教务库只读）
    const instances = getDb('academic')
      .prepare(
        `SELECT si.id, si.date, si.actual_teacher_id, c.default_teacher_id, c.pay_per_session
         FROM schedule_instances si JOIN courses c ON c.id = si.course_id
         WHERE si.status != 'cancelled'`
      )
      .all() as { id: number; date: string; actual_teacher_id: number | null; default_teacher_id: number | null; pay_per_session: number }[]
    const exists = getDb('finance').prepare('SELECT id FROM teacher_payments WHERE teacher_id = ? AND schedule_instance_id = ?')
    const insert = getDb('finance').prepare(
      `INSERT INTO teacher_payments (teacher_id, schedule_instance_id, amount_due, amount_paid, payment_date, note)
       VALUES (?, ?, ?, 0, ?, '自动计算应付')`
    )
    const update = getDb('finance').prepare('UPDATE teacher_payments SET amount_due = ? WHERE teacher_id = ? AND schedule_instance_id = ?')
    const tx = getDb('finance').transaction(() => {
      let count = 0
      for (const si of instances) {
        const teacherId = si.actual_teacher_id ?? si.default_teacher_id
        if (teacherId === null) continue
        const due = Math.round(si.pay_per_session * 100) / 100
        const existing = exists.get(teacherId, si.id) as { id: number } | undefined
        if (existing) update.run(due, teacherId, si.id)
        else insert.run(teacherId, si.id, due, si.date)
        count++
      }
      return count
    })
    return tx()
  })

  ipcMain.handle('finance:getPaymentInstances', (): ScheduleInstance[] => {
    guard()
    const rows = getDb('academic')
      .prepare(
        `SELECT si.*, c.subject, c.grade, c.class_name,
                def.name AS default_teacher_name, act.name AS actual_teacher_name
         FROM schedule_instances si
         JOIN courses c ON c.id = si.course_id
         LEFT JOIN teachers def ON def.id = c.default_teacher_id
         LEFT JOIN teachers act ON act.id = si.actual_teacher_id
         WHERE si.status != 'cancelled'
         ORDER BY si.date DESC, si.start_time DESC`
      )
      .all() as InstanceRow[]
    return rows.map(mapInstance)
  })

  ipcMain.handle('finance:getMonthlyReport', (_e, year: number): MonthReportRow[] => {
    guard()
    const y = String(year ?? new Date().getFullYear())
    const incomeRows = getDb('finance')
      .prepare(`SELECT substr(payment_date, 1, 7) AS month, COALESCE(SUM(amount_paid), 0) AS total FROM student_payments WHERE substr(payment_date, 1, 4) = ? GROUP BY month`)
      .all(y) as { month: string; total: number }[]
    const expenseRows = getDb('finance')
      .prepare(`SELECT substr(payment_date, 1, 7) AS month, COALESCE(SUM(amount_paid), 0) AS total FROM teacher_payments WHERE substr(payment_date, 1, 4) = ? GROUP BY month`)
      .all(y) as { month: string; total: number }[]
    const incomeMap = new Map(incomeRows.map((r) => [r.month, r.total]))
    const expenseMap = new Map(expenseRows.map((r) => [r.month, r.total]))

    const rows: MonthReportRow[] = []
    let totalIncome = 0
    let totalExpense = 0
    for (let m = 1; m <= 12; m++) {
      const month = `${y}-${String(m).padStart(2, '0')}`
      const income = incomeMap.get(month) ?? 0
      const expense = expenseMap.get(month) ?? 0
      totalIncome += income
      totalExpense += expense
      rows.push({ month, income, expense, profit: Math.round((income - expense) * 100) / 100 })
    }
    rows.push({
      month: '合计',
      income: totalIncome,
      expense: totalExpense,
      profit: Math.round((totalIncome - totalExpense) * 100) / 100
    })
    return rows
  })
}

// ---------------------------------------------------------------------------
// 助教（仅 assistant 角色；课程内容记录与短信生成）
// ---------------------------------------------------------------------------

interface LessonNoteRow {
  id: number
  schedule_instance_id: number
  knowledge_points: string | null
  class_performance: string | null
  homework: string | null
  summary: string | null
  homework_grading: string
  created_at: string
  updated_at: string
}

/** 教务库课程实例标签（助教库无实例数据，跨库只读联表） */
function instanceLabelOf(scheduleInstanceId: number): string | undefined {
  const si = getDb('academic')
    .prepare(
      `SELECT si.date, si.start_time, si.end_time, c.subject, c.grade, c.class_name,
              COALESCE(act.name, def.name) AS teacher_name
       FROM schedule_instances si
       JOIN courses c ON c.id = si.course_id
       LEFT JOIN teachers def ON def.id = c.default_teacher_id
       LEFT JOIN teachers act ON act.id = si.actual_teacher_id
       WHERE si.id = ?`
    )
    .get(scheduleInstanceId) as
    | { date: string; start_time: string; end_time: string; subject: string; grade: string; class_name: string; teacher_name: string | null }
    | undefined
  if (!si) return undefined
  return `${si.date} ${courseLabel(si.subject, si.grade, si.class_name)} ${si.start_time}-${si.end_time}`
}

function mapLessonNote(row: LessonNoteRow): LessonNote {
  const si = getDb('academic')
    .prepare(
      `SELECT si.date, si.start_time, si.end_time, c.subject, c.grade, c.class_name,
              COALESCE(act.name, def.name) AS teacher_name
       FROM schedule_instances si
       JOIN courses c ON c.id = si.course_id
       LEFT JOIN teachers def ON def.id = c.default_teacher_id
       LEFT JOIN teachers act ON act.id = si.actual_teacher_id
       WHERE si.id = ?`
    )
    .get(row.schedule_instance_id) as
    | { date: string; start_time: string; end_time: string; subject: string; grade: string; class_name: string; teacher_name: string | null }
    | undefined
  return {
    id: row.id,
    scheduleInstanceId: row.schedule_instance_id,
    knowledgePoints: row.knowledge_points,
    classPerformance: row.class_performance,
    homework: row.homework,
    summary: row.summary,
    homeworkGrading: row.homework_grading,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    date: si?.date,
    startTime: si?.start_time,
    endTime: si?.end_time,
    subject: si?.subject,
    grade: si?.grade,
    className: si?.class_name,
    teacherName: si?.teacher_name
  }
}

function registerAssistantHandlers(): void {
  const guard = (): void => {
    requireRole(['assistant'])
  }

  ipcMain.handle('assistant:getLessonNote', (_e, scheduleInstanceId: number): LessonNote | null => {
    guard()
    const row = getDb('assistant')
      .prepare('SELECT * FROM lesson_notes WHERE schedule_instance_id = ?')
      .get(scheduleInstanceId) as LessonNoteRow | undefined
    return row ? mapLessonNote(row) : null
  })

  ipcMain.handle(
    'assistant:saveLessonNote',
    (
      _e,
      data: { scheduleInstanceId: number; knowledgePoints: string | null; classPerformance: string | null; homework: string | null; summary: string | null }
    ): LessonNote => {
      guard()
      if (!data.scheduleInstanceId) throw new Error('缺少课程实例')
      const existing = getDb('assistant')
        .prepare('SELECT id FROM lesson_notes WHERE schedule_instance_id = ?')
        .get(data.scheduleInstanceId) as { id: number } | undefined
      if (existing) {
        getDb('assistant')
          .prepare(
            `UPDATE lesson_notes SET knowledge_points = ?, class_performance = ?, homework = ?, summary = ?,
             updated_at = datetime('now') WHERE id = ?`
          )
          .run(data.knowledgePoints ?? null, data.classPerformance ?? null, data.homework ?? null, data.summary ?? null, existing.id)
        const row = getDb('assistant').prepare('SELECT * FROM lesson_notes WHERE id = ?').get(existing.id) as LessonNoteRow
        return mapLessonNote(row)
      }
      const result = getDb('assistant')
        .prepare(
          `INSERT INTO lesson_notes (schedule_instance_id, knowledge_points, class_performance, homework, summary, sync_origin)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(data.scheduleInstanceId, data.knowledgePoints ?? null, data.classPerformance ?? null, data.homework ?? null, data.summary ?? null, localCampus())
      const row = getDb('assistant').prepare('SELECT * FROM lesson_notes WHERE id = ?').get(Number(result.lastInsertRowid)) as LessonNoteRow
      return mapLessonNote(row)
    }
  )

  ipcMain.handle('assistant:listLessonNotes', (): LessonNote[] => {
    guard()
    const rows = getDb('assistant').prepare('SELECT * FROM lesson_notes ORDER BY updated_at DESC, id DESC').all() as LessonNoteRow[]
    return rows.map(mapLessonNote)
  })

  ipcMain.handle('assistant:generateSms', async (_e, lessonNoteId: number): Promise<{ content: string }> => {
    guard()
    const note = getDb('assistant').prepare('SELECT * FROM lesson_notes WHERE id = ?').get(lessonNoteId) as LessonNoteRow | undefined
    if (!note) throw new Error('课程记录不存在')
    const mapped = mapLessonNote(note)
    // 该课程的下一次上课时间（供短信结尾预告，提升家长预期与转发意愿）
    const nextInstance = getDb('academic')
      .prepare(
        `SELECT si.date, si.start_time, si.end_time
         FROM schedule_instances si
         WHERE si.course_id = (SELECT course_id FROM schedule_instances WHERE id = ?)
           AND si.status != 'cancelled'
           AND (si.date > ? OR (si.date = ? AND si.start_time > ?))
         ORDER BY si.date, si.start_time LIMIT 1`
      )
      .get(note.schedule_instance_id, mapped.date ?? '0000-00-00', mapped.date ?? '0000-00-00', mapped.startTime ?? '00:00') as
      | { date: string; start_time: string; end_time: string }
      | undefined
    const courseText = [mapped.subject, mapped.grade, mapped.className].filter(Boolean).join('')
    const userPrompt = [
      `课程：${courseText || '（未知课程）'}（上课时间 ${mapped.date ?? '未知日期'} ${mapped.startTime ?? ''}${mapped.startTime && mapped.endTime ? '-' + mapped.endTime : ''}）`,
      `知识点：${note.knowledge_points || '（未填写）'}`,
      `课堂表现：${note.class_performance || '（未填写）'}`,
      `当日作业：${note.homework || '（未填写）'}`,
      `当日总结：${note.summary || '（未填写）'}`,
      `下次上课：${nextInstance ? `${nextInstance.date} ${nextInstance.start_time}-${nextInstance.end_time}` : '（未提供）'}`
    ].join('\n')
    const content = await callLLM('assistant', 'sms', SMS_SYSTEM_PROMPT, userPrompt)
    // 保存到历史
    getDb('assistant')
      .prepare('INSERT INTO generated_messages (lesson_note_id, message_content) VALUES (?, ?)')
      .run(lessonNoteId, content)
    return { content }
  })

  ipcMain.handle('assistant:listMessages', (): GeneratedMessage[] => {
    guard()
    const rows = getDb('assistant')
      .prepare('SELECT gm.*, ln.schedule_instance_id FROM generated_messages gm JOIN lesson_notes ln ON ln.id = gm.lesson_note_id ORDER BY gm.generated_at DESC, gm.id DESC')
      .all() as { id: number; lesson_note_id: number; message_content: string; generated_at: string; schedule_instance_id: number }[]
    return rows.map((r) => ({
      id: r.id,
      lessonNoteId: r.lesson_note_id,
      messageContent: r.message_content,
      generatedAt: r.generated_at,
      instanceLabel: instanceLabelOf(r.schedule_instance_id)
    }))
  })

  ipcMain.handle('assistant:deleteMessage', (_e, id: number): void => {
    guard()
    getDb('assistant').prepare('DELETE FROM generated_messages WHERE id = ?').run(id)
  })
}

// ---------------------------------------------------------------------------
// Agent（教务/财务智能助手）
// ---------------------------------------------------------------------------

function registerAgentHandlers(): void {
  ipcMain.handle('agent:getAlerts', (): AgentAlert[] => {
    const role = requireRole(['academic', 'finance', 'assistant'])
    if (role === 'academic') return getAcademicAlerts()
    if (role === 'finance') return getFinanceAlerts()
    return []
  })

  ipcMain.handle(
    'agent:checkCourseConflict',
    (_e, data: { courseId: number | null; defaultTeacherId: number | null; scheduleRule: ScheduleRule[] }): ConflictItem[] => {
      requireRole(['academic'])
      return checkCourseConflict(data)
    }
  )

  ipcMain.handle(
    'agent:checkInstanceConflict',
    (_e, data: { instanceId: number; date: string; startTime: string; endTime: string; actualTeacherId: number | null }): ConflictItem[] => {
      requireRole(['academic'])
      return checkInstanceConflict(data)
    }
  )

  ipcMain.handle('agent:suggestSlots', (_e, instanceId: number): SlotSuggestion[] => {
    requireRole(['academic'])
    return suggestSlots(instanceId)
  })

  ipcMain.handle('agent:checkDuplicateName', (_e, kind: 'student' | 'teacher', name: string): { matches: string[] } => {
    requireRole(['academic'])
    return checkDuplicateName(kind, name)
  })

  ipcMain.handle('agent:generateReport', async (_e, kind: 'week' | 'month'): Promise<GeneratedContent> => {
    requireRole(['academic'])
    return generateReport(kind)
  })

  ipcMain.handle('agent:reconcile', (): ReconcileResult => {
    requireRole(['finance'])
    return reconcile()
  })

  ipcMain.handle(
    'agent:checkPaymentAnomaly',
    (_e, data: { kind: 'student' | 'teacher'; id?: number; amountPaid: number; amountDue: number }): AnomalyCheckResult => {
      requireRole(['finance'])
      return checkPaymentAnomaly(data)
    }
  )

  ipcMain.handle('agent:trendAnalysis', async (): Promise<GeneratedContent> => {
    requireRole(['finance'])
    return trendAnalysis()
  })

  ipcMain.handle(
    'agent:smartReport',
    async (_e, module: string, columns: { header: string; key: string }[], rows: Record<string, unknown>[]): Promise<GeneratedContent> => {
      requireRole(['finance'])
      return smartReport(module, columns, rows)
    }
  )
}

// ---------------------------------------------------------------------------
// 多校区同步（教务 + 助教角色可用；财务数据不参与同步）
// ---------------------------------------------------------------------------

function registerSyncHandlers(): void {
  const guardSync = (): void => {
    requireRole(['academic', 'assistant'])
  }

  ipcMain.handle('sync:getInfo', (): { campusId: string; campusName: string; history: ReturnType<typeof getSyncHistory> } => {
    guardSync()
    const cfg = getCampusInfo()
    return { campusId: cfg.campusId, campusName: cfg.campusName, history: getSyncHistory() }
  })

  ipcMain.handle('sync:saveCampusName', (_e, name: string): void => {
    guardSync()
    setCampusName(name)
  })

  ipcMain.handle(
    'sync:exportPackage',
    async (): Promise<{ success: boolean; canceled?: boolean; path?: string; counts?: number; error?: string }> => {
      guardSync()
      const pkg = buildSyncPackage()
      const cfg = getCampusInfo()
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出多校区同步包',
        defaultPath: `Vlearn_同步包_${cfg.campusName || '校区'}_${format(new Date(), 'yyyy-MM-dd')}.vsync.json`,
        filters: [{ name: 'Vlearn 同步包', extensions: ['json'] }]
      })
      if (canceled || !filePath) return { success: false, canceled: true }
      fs.writeFileSync(filePath, JSON.stringify(pkg), 'utf8')
      recordExportHistory(pkg, filePath)
      return { success: true, path: filePath, counts: packageRowCount(pkg) }
    }
  )

  ipcMain.handle(
    'sync:importPackage',
    async (): Promise<{ success: boolean; canceled?: boolean; stats?: SyncStats; error?: string }> => {
      guardSync()
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择多校区同步包',
        filters: [{ name: 'Vlearn 同步包', extensions: ['json'] }],
        properties: ['openFile']
      })
      if (canceled || filePaths.length === 0) return { success: false, canceled: true }
      let pkg: SyncPackage
      try {
        const raw = JSON.parse(fs.readFileSync(filePaths[0], 'utf8')) as SyncPackage
        if (raw.version !== 3 || !raw.academic?.tables || !raw.assistant?.tables) {
          throw new Error('文件格式不正确（不是 Vlearn v3 同步包）')
        }
        pkg = raw
      } catch (err) {
        return { success: false, error: `同步包解析失败：${(err as Error).message}` }
      }
      const stats = mergeSyncPackage(pkg)
      return { success: true, stats }
    }
  )
}

// ---------------------------------------------------------------------------
// 设置 / 备份恢复 / 导出
// ---------------------------------------------------------------------------

function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', (): RoleSettings => {
    const role = requireRole(['academic', 'finance', 'assistant'])
    const parseArr = (key: string, fallback: string[]): string[] => {
      try {
        const v = JSON.parse(getSettingValue(role, key) ?? '')
        return Array.isArray(v) ? v.map(String) : fallback
      } catch {
        return fallback
      }
    }
    const flag = (key: string, def = '1'): boolean => (getSettingValue(role, key) ?? def) === '1'
    if (role === 'academic') {
      const s: AcademicSettings = {
        role: 'academic',
        grades: parseArr('grades', ['高一', '高二', '高三']),
        scheduleWeeks: parseInt(getSettingValue(role, 'schedule_weeks') ?? '8', 10) || 8,
        agentConflictDetect: flag('agent_conflict_detect'),
        agentAttendanceAlert: flag('agent_attendance_alert'),
        agentAttendanceThreshold: parseInt(getSettingValue(role, 'agent_attendance_threshold') ?? '3', 10) || 3,
        agentCompletenessHint: flag('agent_completeness_hint'),
        apiUrl: (getSettingValue(role, 'ai_api_url') ?? '').trim(),
        apiKey: (getSettingValue(role, 'ai_api_key') ?? '').trim()
      }
      return s
    }
    if (role === 'finance') {
      const s: FinanceSettings = {
        role: 'finance',
        paymentMethods: parseArr('payment_methods', ['微信', '转账', '现金']),
        chargeAbsent: flag('charge_absent'),
        agentOverdueAlert: flag('agent_overdue_alert'),
        agentOverdueDays: parseInt(getSettingValue(role, 'agent_overdue_days') ?? '7', 10) || 7,
        agentAnomalyDetect: flag('agent_anomaly_detect'),
        agentAnomalyMultiplier: parseFloat(getSettingValue(role, 'agent_anomaly_multiplier') ?? '3') || 3,
        apiUrl: (getSettingValue(role, 'ai_api_url') ?? '').trim(),
        apiKey: (getSettingValue(role, 'ai_api_key') ?? '').trim()
      }
      return s
    }
    const s: AssistantSettings = {
      role: 'assistant',
      apiUrl: (getSettingValue(role, 'ai_api_url') ?? '').trim(),
      apiKey: (getSettingValue(role, 'ai_api_key') ?? '').trim()
    }
    return s
  })

  ipcMain.handle('settings:save', (_e, data: RoleSettings): void => {
    const role = requireRole(['academic', 'finance', 'assistant'])
    const set = (key: string, value: string): void => setSettingValue(role, key, value)
    if (role === 'academic') {
      const s = data as AcademicSettings
      const grades = (s.grades ?? []).map(String).filter((x) => x.trim())
      if (grades.length === 0) throw new Error('年级选项不能为空')
      set('grades', JSON.stringify(grades))
      set('schedule_weeks', String(Math.max(1, Math.min(52, Number(s.scheduleWeeks) || 8))))
      set('agent_conflict_detect', s.agentConflictDetect ? '1' : '0')
      set('agent_attendance_alert', s.agentAttendanceAlert ? '1' : '0')
      set('agent_attendance_threshold', String(Math.max(1, Math.min(10, Number(s.agentAttendanceThreshold) || 3))))
      set('agent_completeness_hint', s.agentCompletenessHint ? '1' : '0')
      set('ai_api_url', String(s.apiUrl ?? '').trim())
      set('ai_api_key', String(s.apiKey ?? '').trim())
      return
    }
    if (role === 'finance') {
      const s = data as FinanceSettings
      const methods = (s.paymentMethods ?? []).map(String).filter((x) => x.trim())
      if (methods.length === 0) throw new Error('缴费方式不能为空')
      set('payment_methods', JSON.stringify(methods))
      set('charge_absent', s.chargeAbsent ? '1' : '0')
      set('agent_overdue_alert', s.agentOverdueAlert ? '1' : '0')
      set('agent_overdue_days', String(Math.max(1, Math.min(30, Number(s.agentOverdueDays) || 7))))
      set('agent_anomaly_detect', s.agentAnomalyDetect ? '1' : '0')
      set('agent_anomaly_multiplier', String(Math.max(1, Math.min(10, Number(s.agentAnomalyMultiplier) || 3))))
      set('ai_api_url', String(s.apiUrl ?? '').trim())
      set('ai_api_key', String(s.apiKey ?? '').trim())
      return
    }
    const s = data as AssistantSettings
    set('ai_api_url', String(s.apiUrl ?? '').trim())
    set('ai_api_key', String(s.apiKey ?? '').trim())
  })

  ipcMain.handle('app:getVersion', (): string => app.getVersion())

  // ---------- 备份 / 恢复（覆盖三个角色数据库） ----------

  ipcMain.handle('backup:create', async (): Promise<{ success: boolean; canceled?: boolean; path?: string }> => {
    requireRole(['academic', 'finance', 'assistant'])
    const stamp = format(new Date(), 'yyyy-MM-dd')
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '备份数据（将生成三个数据库文件）',
      defaultPath: `Vlearn_数据备份_${stamp}`,
      filters: [{ name: '备份基础名', extensions: ['db'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    const base = filePath.replace(/\.db$/i, '')
    const suffix: Record<Role, string> = { academic: '教务', finance: '财务', assistant: '助教' }
    const paths: string[] = []
    for (const role of Object.keys(suffix) as Role[]) {
      const target = `${base}_${suffix[role]}.db`
      await getDb(role).backup(target)
      paths.push(target)
    }
    return { success: true, path: paths.join('、') }
  })

  ipcMain.handle('backup:restore', async (): Promise<{ success: boolean; canceled?: boolean; error?: string }> => {
    requireRole(['academic', 'finance', 'assistant'])
    const expectTable: Record<Role, string> = { academic: 'students', finance: 'student_payments', assistant: 'lesson_notes' }
    const files = {} as Record<Role, string>
    for (const role of Object.keys(expectTable) as Role[]) {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: `选择${roleLabel(role)}数据库备份文件`,
        filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
        properties: ['openFile']
      })
      if (canceled || filePaths.length === 0) return { success: false, canceled: true }
      const src = filePaths[0]
      try {
        const probe = new Database(src, { readonly: true })
        const ok = probe
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(expectTable[role])
        probe.close()
        if (!ok) throw new Error(`缺少 ${expectTable[role]} 表`)
      } catch (err) {
        return { success: false, error: `所选${roleLabel(role)}备份无效：${(err as Error).message}` }
      }
      files[role] = src
    }
    try {
      closeAll()
      for (const role of Object.keys(files) as Role[]) {
        fs.copyFileSync(files[role], getDbPath(role))
      }
      initDatabases()
    } catch (err) {
      return { success: false, error: `恢复失败：${(err as Error).message}` }
    }
    for (const win of BrowserWindow.getAllWindows()) win.webContents.reload()
    return { success: true }
  })

  ipcMain.handle(
    'export:excel',
    async (_e, payload: ExcelExportPayload): Promise<{ success: boolean; canceled?: boolean; path?: string }> => {
      requireRole(['academic', 'finance', 'assistant'])
      const moduleName = String(payload.module ?? '导出').slice(0, 20)
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出 Excel',
        defaultPath: exportFileName(moduleName),
        filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }]
      })
      if (canceled || !filePath) return { success: false, canceled: true }
      const workbook = await buildWorkbook(moduleName, payload.columns, payload.rows)
      await workbook.xlsx.writeFile(filePath)
      return { success: true, path: filePath }
    }
  )
}

/** 注册全部 IPC 处理器 */
export function registerIpcHandlers(): void {
  registerAuthHandlers()
  registerCourseHandlers()
  registerTeacherHandlers()
  registerStudentHandlers()
  registerInstanceHandlers()
  registerFinanceHandlers()
  registerAssistantHandlers()
  registerAgentHandlers()
  registerSyncHandlers()
  registerSettingsHandlers()
}
