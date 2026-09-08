/**
 * IPC 处理器：渲染进程通过 window.api（preload 暴露）调用此处注册的方法，
 * 所有数据库读写均在此完成。
 *
 * 权限模型：
 * - 教务操作（课程/老师/学生/排课/考勤）无需验证，应用启动即教务端；
 * - 财务相关 IPC 均先经过 ensureFinance() 校验主进程内的财务会话标记，
 *   该标记仅能通过 finance:verifyPassword 校验密码后置位。
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import { format } from 'date-fns'
import type {
  AppSettings,
  AttendanceStatus,
  Course,
  DashboardData,
  ExcelExportPayload,
  InstanceDetail,
  MonthReportRow,
  ScheduleInstance,
  ScheduleRule,
  Student,
  StudentDetail,
  StudentPayment,
  Teacher,
  TeacherDetail,
  TeacherPayment
} from '../src/types'
import { getDb, getDbPath, getSetting, initDb, closeDb, setSetting, sha256 } from './db'
import { buildWorkbook, exportFileName } from './excelExport'
import { generateInstances } from './schedule'

/** 财务会话标记：应用启动为 false，密码验证通过后为 true */
let financeUnlocked = false

/** 校验财务权限，未解锁时抛出异常 */
function ensureFinance(): void {
  if (!financeUnlocked) throw new Error('无权访问财务数据，请先输入财务密码')
}

// ---------------------------------------------------------------------------
// 行映射工具：SQL 列名（snake_case）→ 前端字段（camelCase）
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

function mapCourse(row: CourseRow): Course {
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
    fee: row.fee,
    payPerSession: row.pay_per_session,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 课程标签，如 "数学 高一 A1班" */
export function courseLabel(subject: string, grade: string, className: string): string {
  return `${subject} ${grade} ${className}`
}

const COURSE_SELECT = `
  SELECT c.*, t.name AS default_teacher_name
  FROM courses c
  LEFT JOIN teachers t ON t.id = c.default_teacher_id
`

function fetchCourse(id: number): Course | null {
  const row = getDb().prepare(`${COURSE_SELECT} WHERE c.id = ?`).get(id) as CourseRow | undefined
  return row ? mapCourse(row) : null
}

/** 读取课程的关联 id 列表 */
function relationIds(table: 'teacher_courses' | 'student_courses', ownerCol: string, ownerId: number): number[] {
  const rows = getDb().prepare(`SELECT course_id FROM ${table} WHERE ${ownerCol} = ? ORDER BY course_id`).all(ownerId) as {
    course_id: number
  }[]
  return rows.map((r) => r.course_id)
}

function courseLabelsByIds(ids: number[]): string[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  const rows = getDb()
    .prepare(`SELECT subject, grade, class_name FROM courses WHERE id IN (${placeholders}) ORDER BY id`)
    .all(...ids) as { subject: string; grade: string; class_name: string }[]
  return rows.map((r) => courseLabel(r.subject, r.grade, r.class_name))
}

// ---------------------------------------------------------------------------
// 课程
// ---------------------------------------------------------------------------

function registerCourseHandlers(): void {
  ipcMain.handle('courses:getAll', (): Course[] => {
    const rows = getDb().prepare(`${COURSE_SELECT} ORDER BY c.id`).all() as CourseRow[]
    return rows.map(mapCourse)
  })

  ipcMain.handle(
    'courses:create',
    (_e, data: { subject: string; grade: string; className: string; defaultTeacherId: number | null; scheduleRule: ScheduleRule[] }): Course => {
      const subject = String(data.subject ?? '').trim()
      const grade = String(data.grade ?? '').trim()
      const className = String(data.className ?? '').trim()
      if (!subject || !grade || !className) throw new Error('科目、年级、班级号不能为空')
      const result = getDb()
        .prepare(
          `INSERT INTO courses (subject, grade, class_name, default_teacher_id, default_schedule_rule)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(subject, grade, className, data.defaultTeacherId ?? null, JSON.stringify(data.scheduleRule ?? []))
      const courseId = Number(result.lastInsertRowid)
      // 创建课程后自动生成未来 N 周课程实例
      const weeks = parseInt(getSetting('schedule_weeks') ?? '8', 10) || 8
      generateInstances(getDb(),courseId, data.scheduleRule ?? [], new Date(), weeks)
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
      const course = fetchCourse(id)
      if (!course) throw new Error('课程不存在')
      const subject = String(data.subject ?? '').trim()
      const grade = String(data.grade ?? '').trim()
      const className = String(data.className ?? '').trim()
      if (!subject || !grade || !className) throw new Error('科目、年级、班级号不能为空')
      // 仅更新基础信息；已生成的课程实例不自动变化，需手动"重新生成排课"
      getDb().prepare(
        `UPDATE courses SET subject = ?, grade = ?, class_name = ?, default_teacher_id = ?, default_schedule_rule = ?,
         updated_at = datetime('now') WHERE id = ?`
      ).run(subject, grade, className, data.defaultTeacherId ?? null, JSON.stringify(data.scheduleRule ?? []), id)
      return fetchCourse(id)!
    }
  )

  ipcMain.handle('courses:delete', (_e, id: number): void => {
    // 级联删除课程实例、考勤、缴费/课酬记录（外键 ON DELETE CASCADE）
    getDb().prepare('DELETE FROM courses WHERE id = ?').run(id)
  })

  ipcMain.handle('courses:regenerate', (_e, courseId: number): number => {
    const course = fetchCourse(courseId)
    if (!course) throw new Error('课程不存在')
    // 删除今天及未来的实例，保留历史（过去）实例，再按当前规则重新生成
    const today = format(new Date(), 'yyyy-MM-dd')
    getDb().prepare('DELETE FROM schedule_instances WHERE course_id = ? AND date >= ?').run(courseId, today)
    const weeks = parseInt(getSetting('schedule_weeks') ?? '8', 10) || 8
    return generateInstances(getDb(),courseId, course.scheduleRule, new Date(), weeks)
  })
}

// ---------------------------------------------------------------------------
// 老师
// ---------------------------------------------------------------------------

function registerTeacherHandlers(): void {
  ipcMain.handle('teachers:getAll', (): Teacher[] => {
    const rows = getDb().prepare('SELECT * FROM teachers ORDER BY id').all() as {
      id: number
      name: string
      note: string | null
    }[]
    return rows.map((row) => {
      const courseIds = relationIds('teacher_courses', 'teacher_id', row.id)
      return {
        id: row.id,
        name: row.name,
        note: row.note,
        courseIds,
        courseLabels: courseLabelsByIds(courseIds)
      }
    })
  })

  ipcMain.handle('teachers:getDetail', (_e, id: number): TeacherDetail => {
    const row = getDb().prepare('SELECT * FROM teachers WHERE id = ?').get(id) as
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
    const total = getDb()
      .prepare(
        `SELECT COUNT(*) AS c FROM schedule_instances si
         JOIN courses c ON c.id = si.course_id
         WHERE si.actual_teacher_id = ? OR (si.actual_teacher_id IS NULL AND c.default_teacher_id = ?)`
      )
      .get(id, id) as { c: number }
    const upcoming = getDb()
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
    const tx = getDb().transaction(() => {
      getDb().prepare('DELETE FROM teacher_courses WHERE teacher_id = ?').run(teacherId)
      const insert = getDb().prepare('INSERT INTO teacher_courses (teacher_id, course_id) VALUES (?, ?)')
      for (const courseId of courseIds) insert.run(teacherId, courseId)
    })
    tx()
  }

  ipcMain.handle(
    'teachers:create',
    (_e, data: { name: string; note: string | null; courseIds: number[] }): Teacher => {
      const name = String(data.name ?? '').trim()
      if (!name) throw new Error('老师姓名不能为空')
      const result = getDb().prepare('INSERT INTO teachers (name, note) VALUES (?, ?)').run(name, data.note ?? null)
      const id = Number(result.lastInsertRowid)
      replaceTeacherCourses(id, data.courseIds ?? [])
      const row = getDb().prepare('SELECT * FROM teachers WHERE id = ?').get(id) as {
        id: number
        name: string
        note: string | null
      }
      return {
        id: row.id,
        name: row.name,
        note: row.note,
        courseIds: data.courseIds ?? [],
        courseLabels: courseLabelsByIds(data.courseIds ?? [])
      }
    }
  )

  ipcMain.handle(
    'teachers:update',
    (_e, id: number, data: { name: string; note: string | null; courseIds: number[] }): Teacher => {
      const name = String(data.name ?? '').trim()
      if (!name) throw new Error('老师姓名不能为空')
      getDb().prepare('UPDATE teachers SET name = ?, note = ? WHERE id = ?').run(name, data.note ?? null, id)
      replaceTeacherCourses(id, data.courseIds ?? [])
      const row = getDb().prepare('SELECT * FROM teachers WHERE id = ?').get(id) as {
        id: number
        name: string
        note: string | null
      }
      return {
        id: row.id,
        name: row.name,
        note: row.note,
        courseIds: data.courseIds ?? [],
        courseLabels: courseLabelsByIds(data.courseIds ?? [])
      }
    }
  )

  ipcMain.handle('teachers:delete', (_e, id: number): void => {
    // 解除课程默认老师引用（课酬/考勤关联的外键为 SET NULL / CASCADE）
    getDb().prepare('DELETE FROM teachers WHERE id = ?').run(id)
  })
}

// ---------------------------------------------------------------------------
// 学生
// ---------------------------------------------------------------------------

function registerStudentHandlers(): void {
  ipcMain.handle('students:getAll', (): Student[] => {
    const rows = getDb().prepare('SELECT * FROM students ORDER BY id').all() as {
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
    const row = getDb().prepare('SELECT * FROM students WHERE id = ?').get(id) as
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
    const attendances = getDb()
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
    const tx = getDb().transaction(() => {
      getDb().prepare('DELETE FROM student_courses WHERE student_id = ?').run(studentId)
      const insert = getDb().prepare('INSERT INTO student_courses (student_id, course_id) VALUES (?, ?)')
      for (const courseId of courseIds) insert.run(studentId, courseId)
    })
    tx()
  }

  ipcMain.handle(
    'students:create',
    (_e, data: { name: string; schoolClass: string | null; note: string | null; courseIds: number[] }): Student => {
      const name = String(data.name ?? '').trim()
      if (!name) throw new Error('学生姓名不能为空')
      const result = getDb()
        .prepare('INSERT INTO students (name, school_class, note) VALUES (?, ?, ?)')
        .run(name, data.schoolClass ?? null, data.note ?? null)
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
      const name = String(data.name ?? '').trim()
      if (!name) throw new Error('学生姓名不能为空')
      getDb().prepare('UPDATE students SET name = ?, school_class = ?, note = ? WHERE id = ?').run(
        name,
        data.schoolClass ?? null,
        data.note ?? null,
        id
      )
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
    getDb().prepare('DELETE FROM students WHERE id = ?').run(id)
  })
}

// ---------------------------------------------------------------------------
// 课程实例与考勤
// ---------------------------------------------------------------------------

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

function registerInstanceHandlers(): void {
  ipcMain.handle('instances:getRange', (_e, start: string, end: string): ScheduleInstance[] => {
    const rows = getDb()
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
    const row = getDb()
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
    const course = fetchCourse(row.course_id)!
    const students = getDb()
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
      if (!data.date || !data.startTime || !data.endTime) throw new Error('日期与时间不能为空')
      getDb().prepare(
        `UPDATE schedule_instances
         SET date = ?, start_time = ?, end_time = ?, actual_teacher_id = ?, note = ?, status = 'adjusted'
         WHERE id = ?`
      ).run(data.date, data.startTime, data.endTime, data.actualTeacherId ?? null, data.note ?? null, id)
      const row = getDb()
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
    getDb().prepare(`UPDATE schedule_instances SET status = 'cancelled' WHERE id = ?`).run(id)
  })

  ipcMain.handle('instances:restore', (_e, id: number): void => {
    getDb().prepare(`UPDATE schedule_instances SET status = 'normal' WHERE id = ?`).run(id)
  })

  ipcMain.handle(
    'attendance:save',
    (_e, data: { scheduleInstanceId: number; studentId: number; status: AttendanceStatus; note?: string | null }): void => {
      if (!['present', 'leave', 'absent'].includes(data.status)) throw new Error('无效的考勤状态')
      getDb().prepare(
        `INSERT INTO attendances (schedule_instance_id, student_id, status, note)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(schedule_instance_id, student_id)
         DO UPDATE SET status = excluded.status, note = excluded.note, created_at = datetime('now')`
      ).run(data.scheduleInstanceId, data.studentId, data.status, data.note ?? null)
    }
  )

  ipcMain.handle('attendance:remove', (_e, data: { scheduleInstanceId: number; studentId: number }): void => {
    getDb().prepare('DELETE FROM attendances WHERE schedule_instance_id = ? AND student_id = ?').run(
      data.scheduleInstanceId,
      data.studentId
    )
  })

  ipcMain.handle('attendance:markAllPresent', (_e, scheduleInstanceId: number): number => {
    const instance = getDb().prepare('SELECT course_id FROM schedule_instances WHERE id = ?').get(scheduleInstanceId) as
      | { course_id: number }
      | undefined
    if (!instance) throw new Error('课程实例不存在')
    const result = getDb()
      .prepare(
        `INSERT INTO attendances (schedule_instance_id, student_id, status)
         SELECT ?, sc.student_id, 'present' FROM student_courses sc WHERE sc.course_id = ?
         ON CONFLICT(schedule_instance_id, student_id) DO UPDATE SET status = 'present', created_at = datetime('now')`
      )
      .run(scheduleInstanceId, instance.course_id)
    return result.changes
  })
}

// ---------------------------------------------------------------------------
// 财务：密码与会话
// ---------------------------------------------------------------------------

function registerFinanceSessionHandlers(): void {
  ipcMain.handle('finance:verifyPassword', (_e, password: string): boolean => {
    const hash = getSetting('finance_password_hash')
    if (hash && sha256(String(password ?? '')) === hash) {
      financeUnlocked = true
      return true
    }
    return false
  })

  ipcMain.handle('finance:logout', (): void => {
    financeUnlocked = false
  })

  ipcMain.handle(
    'finance:changePassword',
    (_e, oldPassword: string, newPassword: string): { success: boolean; error?: string } => {
      const hash = getSetting('finance_password_hash')
      if (hash && sha256(String(oldPassword ?? '')) !== hash) {
        return { success: false, error: '旧密码不正确' }
      }
      const next = String(newPassword ?? '')
      if (next.length < 6) return { success: false, error: '新密码长度至少 6 位' }
      setSetting('finance_password_hash', sha256(next))
      return { success: true }
    }
  )
}

// ---------------------------------------------------------------------------
// 财务：仪表盘 / 课程费用 / 学生缴费 / 老师课酬 / 报表
// ---------------------------------------------------------------------------

function registerFinanceHandlers(): void {
  ipcMain.handle('finance:getDashboard', (_e, month: string): DashboardData => {
    ensureFinance()
    const m = String(month ?? '')
    if (!/^\d{4}-\d{2}$/.test(m)) throw new Error('月份格式应为 YYYY-MM')
    const sum = (sql: string): number => {
      const row = getDb().prepare(sql).get(m) as { s: number } | undefined
      return row?.s ?? 0
    }
    const studentDue = sum(
      `SELECT COALESCE(SUM(amount_due), 0) AS s FROM student_payments WHERE substr(payment_date, 1, 7) = ?`
    )
    const studentPaid = sum(
      `SELECT COALESCE(SUM(amount_paid), 0) AS s FROM student_payments WHERE substr(payment_date, 1, 7) = ?`
    )
    const teacherDue = sum(
      `SELECT COALESCE(SUM(amount_due), 0) AS s FROM teacher_payments WHERE substr(payment_date, 1, 7) = ?`
    )
    const teacherPaid = sum(
      `SELECT COALESCE(SUM(amount_paid), 0) AS s FROM teacher_payments WHERE substr(payment_date, 1, 7) = ?`
    )
    return {
      studentDue,
      studentPaid,
      teacherDue,
      teacherPaid,
      profit: studentPaid - teacherPaid
    }
  })

  ipcMain.handle('finance:getCourses', (): Course[] => {
    ensureFinance()
    const rows = getDb().prepare(`${COURSE_SELECT} ORDER BY c.id`).all() as CourseRow[]
    return rows.map(mapCourse)
  })

  ipcMain.handle(
    'finance:updateCourseFees',
    (_e, id: number, data: { fee: number; payPerSession: number }): Course => {
      ensureFinance()
      getDb().prepare(
        `UPDATE courses SET fee = ?, pay_per_session = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(Number(data.fee) || 0, Number(data.payPerSession) || 0, id)
      return fetchCourse(id)!
    }
  )

  // ---------- 学生缴费 ----------

  ipcMain.handle('finance:getStudentPayments', (): StudentPayment[] => {
    ensureFinance()
    const rows = getDb()
      .prepare(
        `SELECT sp.*, s.name AS student_name, c.subject, c.grade, c.class_name
         FROM student_payments sp
         JOIN students s ON s.id = sp.student_id
         JOIN courses c ON c.id = sp.course_id
         ORDER BY sp.payment_date DESC, sp.id DESC`
      )
      .all() as {
      id: number
      student_id: number
      course_id: number
      amount_due: number
      amount_paid: number
      payment_method: string
      payment_date: string
      note: string | null
      student_name: string
      subject: string
      grade: string
      class_name: string
    }[]
    return rows.map((r) => ({
      id: r.id,
      studentId: r.student_id,
      courseId: r.course_id,
      amountDue: r.amount_due,
      amountPaid: r.amount_paid,
      paymentMethod: r.payment_method,
      paymentDate: r.payment_date,
      note: r.note,
      studentName: r.student_name,
      courseLabel: courseLabel(r.subject, r.grade, r.class_name)
    }))
  })

  ipcMain.handle(
    'finance:createStudentPayment',
    (
      _e,
      data: { studentId: number; courseId: number; amountDue: number; amountPaid: number; paymentMethod: string; paymentDate: string; note: string | null }
    ): void => {
      ensureFinance()
      if (!data.studentId || !data.courseId || !data.paymentDate) throw new Error('学生、课程、缴费日期不能为空')
      getDb().prepare(
        `INSERT INTO student_payments (student_id, course_id, amount_due, amount_paid, payment_method, payment_date, note)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        data.studentId,
        data.courseId,
        Number(data.amountDue) || 0,
        Number(data.amountPaid) || 0,
        data.paymentMethod || '现金',
        data.paymentDate,
        data.note ?? null
      )
    }
  )

  ipcMain.handle(
    'finance:updateStudentPayment',
    (
      _e,
      id: number,
      data: { studentId: number; courseId: number; amountDue: number; amountPaid: number; paymentMethod: string; paymentDate: string; note: string | null }
    ): void => {
      ensureFinance()
      if (!data.studentId || !data.courseId || !data.paymentDate) throw new Error('学生、课程、缴费日期不能为空')
      getDb().prepare(
        `UPDATE student_payments
         SET student_id = ?, course_id = ?, amount_due = ?, amount_paid = ?, payment_method = ?, payment_date = ?, note = ?
         WHERE id = ?`
      ).run(
        data.studentId,
        data.courseId,
        Number(data.amountDue) || 0,
        Number(data.amountPaid) || 0,
        data.paymentMethod || '现金',
        data.paymentDate,
        data.note ?? null,
        id
      )
    }
  )

  ipcMain.handle('finance:deleteStudentPayment', (_e, id: number): void => {
    ensureFinance()
    getDb().prepare('DELETE FROM student_payments WHERE id = ?').run(id)
  })

  ipcMain.handle('finance:autoCalcStudentPayments', (): number => {
    ensureFinance()
    // 应缴 = 课程费用 × 计费出勤次数（出勤 + 可选缺勤；请假不收费）
    const chargeAbsent = (getSetting('charge_absent') ?? '1') === '1'
    const statuses = chargeAbsent ? "('present','absent')" : "('present')"
    const pairs = getDb()
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

    const upsert = getDb().prepare(
      `INSERT INTO student_payments (student_id, course_id, amount_due, amount_paid, payment_method, payment_date, note)
       VALUES (?, ?, ?, 0, ?, ?, '自动计算应缴')
       ON CONFLICT(id) DO NOTHING`
    )
    const updateDue = getDb().prepare(
      `UPDATE student_payments SET amount_due = ? WHERE student_id = ? AND course_id = ?`
    )
    const today = format(new Date(), 'yyyy-MM-dd')
    const firstMethod = (JSON.parse(getSetting('payment_methods') ?? '["现金"]') as string[])[0] ?? '现金'
    const tx = getDb().transaction(() => {
      let count = 0
      for (const p of pairs) {
        const existing = getDb()
          .prepare('SELECT id FROM student_payments WHERE student_id = ? AND course_id = ?')
          .get(p.student_id, p.course_id) as { id: number } | undefined
        const due = Math.round(p.cnt * p.fee * 100) / 100
        if (existing) {
          updateDue.run(due, p.student_id, p.course_id)
        } else {
          upsert.run(p.student_id, p.course_id, due, firstMethod, today)
        }
        count++
      }
      return count
    })
    return tx()
  })

  // ---------- 老师课酬 ----------

  ipcMain.handle('finance:getTeacherPayments', (): TeacherPayment[] => {
    ensureFinance()
    const rows = getDb()
      .prepare(
        `SELECT tp.*, t.name AS teacher_name,
                si.date, si.start_time, si.end_time, c.subject, c.grade, c.class_name
         FROM teacher_payments tp
         JOIN teachers t ON t.id = tp.teacher_id
         JOIN schedule_instances si ON si.id = tp.schedule_instance_id
         JOIN courses c ON c.id = si.course_id
         ORDER BY tp.payment_date DESC, tp.id DESC`
      )
      .all() as {
      id: number
      teacher_id: number
      schedule_instance_id: number
      amount_due: number
      amount_paid: number
      payment_date: string
      note: string | null
      teacher_name: string
      date: string
      start_time: string
      end_time: string
      subject: string
      grade: string
      class_name: string
    }[]
    return rows.map((r) => ({
      id: r.id,
      teacherId: r.teacher_id,
      scheduleInstanceId: r.schedule_instance_id,
      amountDue: r.amount_due,
      amountPaid: r.amount_paid,
      paymentDate: r.payment_date,
      note: r.note,
      teacherName: r.teacher_name,
      instanceLabel: `${r.date} ${courseLabel(r.subject, r.grade, r.class_name)} ${r.start_time}-${r.end_time}`
    }))
  })

  ipcMain.handle(
    'finance:createTeacherPayment',
    (
      _e,
      data: { teacherId: number; scheduleInstanceId: number; amountDue: number; amountPaid: number; paymentDate: string; note: string | null }
    ): void => {
      ensureFinance()
      if (!data.teacherId || !data.scheduleInstanceId || !data.paymentDate) throw new Error('老师、课程实例、支付日期不能为空')
      getDb().prepare(
        `INSERT INTO teacher_payments (teacher_id, schedule_instance_id, amount_due, amount_paid, payment_date, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        data.teacherId,
        data.scheduleInstanceId,
        Number(data.amountDue) || 0,
        Number(data.amountPaid) || 0,
        data.paymentDate,
        data.note ?? null
      )
    }
  )

  ipcMain.handle(
    'finance:updateTeacherPayment',
    (
      _e,
      id: number,
      data: { teacherId: number; scheduleInstanceId: number; amountDue: number; amountPaid: number; paymentDate: string; note: string | null }
    ): void => {
      ensureFinance()
      if (!data.teacherId || !data.scheduleInstanceId || !data.paymentDate) throw new Error('老师、课程实例、支付日期不能为空')
      getDb().prepare(
        `UPDATE teacher_payments
         SET teacher_id = ?, schedule_instance_id = ?, amount_due = ?, amount_paid = ?, payment_date = ?, note = ?
         WHERE id = ?`
      ).run(
        data.teacherId,
        data.scheduleInstanceId,
        Number(data.amountDue) || 0,
        Number(data.amountPaid) || 0,
        data.paymentDate,
        data.note ?? null,
        id
      )
    }
  )

  ipcMain.handle('finance:deleteTeacherPayment', (_e, id: number): void => {
    ensureFinance()
    getDb().prepare('DELETE FROM teacher_payments WHERE id = ?').run(id)
  })

  ipcMain.handle('finance:autoCalcTeacherPayments', (): number => {
    ensureFinance()
    // 应付 = 课程单次课酬标准；代课场景支付给代课老师
    const instances = getDb()
      .prepare(
        `SELECT si.id, si.date, si.actual_teacher_id, c.default_teacher_id, c.pay_per_session
         FROM schedule_instances si
         JOIN courses c ON c.id = si.course_id
         WHERE si.status != 'cancelled'`
      )
      .all() as {
      id: number
      date: string
      actual_teacher_id: number | null
      default_teacher_id: number | null
      pay_per_session: number
    }[]
    const exists = getDb().prepare(
      'SELECT id FROM teacher_payments WHERE teacher_id = ? AND schedule_instance_id = ?'
    )
    const insert = getDb().prepare(
      `INSERT INTO teacher_payments (teacher_id, schedule_instance_id, amount_due, amount_paid, payment_date, note)
       VALUES (?, ?, ?, 0, ?, '自动计算应付')`
    )
    const update = getDb().prepare(
      'UPDATE teacher_payments SET amount_due = ? WHERE teacher_id = ? AND schedule_instance_id = ?'
    )
    const tx = getDb().transaction(() => {
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
    ensureFinance()
    const rows = getDb()
      .prepare(
        `SELECT si.*, c.subject, c.grade, c.class_name, c.pay_per_session,
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
    ensureFinance()
    const y = String(year ?? new Date().getFullYear())
    const incomeRows = getDb()
      .prepare(
        `SELECT substr(payment_date, 1, 7) AS month, COALESCE(SUM(amount_paid), 0) AS total
         FROM student_payments WHERE substr(payment_date, 1, 4) = ? GROUP BY month`
      )
      .all(y) as { month: string; total: number }[]
    const expenseRows = getDb()
      .prepare(
        `SELECT substr(payment_date, 1, 7) AS month, COALESCE(SUM(amount_paid), 0) AS total
         FROM teacher_payments WHERE substr(payment_date, 1, 4) = ? GROUP BY month`
      )
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
// 设置 / 备份恢复 / 导出
// ---------------------------------------------------------------------------

function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', (): AppSettings => {
    const parseArr = (key: string, fallback: string[]): string[] => {
      try {
        const v = JSON.parse(getSetting(key) ?? '')
        return Array.isArray(v) ? v.map(String) : fallback
      } catch {
        return fallback
      }
    }
    return {
      grades: parseArr('grades', ['高一', '高二', '高三']),
      paymentMethods: parseArr('payment_methods', ['微信', '转账', '现金']),
      scheduleWeeks: parseInt(getSetting('schedule_weeks') ?? '8', 10) || 8,
      chargeAbsent: (getSetting('charge_absent') ?? '1') === '1'
    }
  })

  // 应用版本号（打包后读取自安装包内的 package.json，用于"关于"页展示）
  ipcMain.handle('app:getVersion', (): string => app.getVersion())

  ipcMain.handle('settings:save', (_e, data: AppSettings): void => {
    const grades = (data.grades ?? []).map(String).filter((s) => s.trim())
    const paymentMethods = (data.paymentMethods ?? []).map(String).filter((s) => s.trim())
    if (grades.length === 0) throw new Error('年级选项不能为空')
    if (paymentMethods.length === 0) throw new Error('缴费方式不能为空')
    setSetting('grades', JSON.stringify(grades))
    setSetting('payment_methods', JSON.stringify(paymentMethods))
    setSetting('schedule_weeks', String(Math.max(1, Math.min(52, Number(data.scheduleWeeks) || 8))))
    setSetting('charge_absent', data.chargeAbsent ? '1' : '0')
  })

  ipcMain.handle('backup:create', async (): Promise<{ success: boolean; canceled?: boolean; path?: string }> => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '备份数据',
      defaultPath: exportFileName('数据备份').replace('.xlsx', '.db'),
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }]
    })
    if (canceled || !filePath) return { success: false, canceled: true }
    await getDb().backup(filePath)
    return { success: true, path: filePath }
  })

  ipcMain.handle('backup:restore', async (): Promise<{ success: boolean; canceled?: boolean; error?: string }> => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      title: '选择备份文件',
      filters: [{ name: 'SQLite 数据库', extensions: ['db'] }],
      properties: ['openFile']
    })
    if (canceled || filePaths.length === 0) return { success: false, canceled: true }
    const src = filePaths[0]
    try {
      // 校验备份文件是否为有效的 Vlearn 数据库
      const probe = new Database(src, { readonly: true })
      const hasStudents = probe
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'students'`)
        .get()
      probe.close()
      if (!hasStudents) throw new Error('缺少 students 表')
    } catch (err) {
      return { success: false, error: `所选文件不是有效的 Vlearn 备份：${(err as Error).message}` }
    }
    try {
      // 关闭连接 → 覆盖数据库文件 → 重新打开
      closeDb()
      fs.copyFileSync(src, getDbPath())
      initDb()
    } catch (err) {
      return { success: false, error: `恢复失败：${(err as Error).message}` }
    }
    // 重载渲染进程，使全部页面重新读取恢复后的数据
    for (const win of BrowserWindow.getAllWindows()) win.webContents.reload()
    return { success: true }
  })

  ipcMain.handle(
    'export:excel',
    async (_e, payload: ExcelExportPayload): Promise<{ success: boolean; canceled?: boolean; path?: string }> => {
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

/** 注册全部 IPC 处理器。
 *  处理器内部统一通过 getDb() 动态获取连接：恢复备份后连接会重建，闭包捕获旧连接会导致错误。 */
export function registerIpcHandlers(): void {
  registerCourseHandlers()
  registerTeacherHandlers()
  registerStudentHandlers()
  registerInstanceHandlers()
  registerFinanceSessionHandlers()
  registerFinanceHandlers()
  registerSettingsHandlers()
}
