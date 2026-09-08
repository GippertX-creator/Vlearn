/**
 * Agent 逻辑（教务 Agent / 财务 Agent）：
 * - 检测类能力（排课冲突、考勤异常、信息补全、对账差异、缴费逾期、异常交易）
 *   全部使用本地确定性规则，离线可用、毫秒级响应；
 * - 文本生成类能力（周报/月报、趋势分析、智能报表、短信）优先调用外部大模型
 *   （配置见各角色"系统设置 → Agent 配置"），未配置时回退到系统模板，
 *   通过 GeneratedContent.usedAi 告知渲染层实际来源。
 */
import { format } from 'date-fns'
import type {
  AgentAlert,
  AnomalyCheckResult,
  ConflictItem,
  GeneratedContent,
  ReconcileResult,
  SlotSuggestion,
  ScheduleRule
} from '../src/types'
import { AINotConfiguredError, callLLM, isAIConfigured } from './ai'
import { getDb, getSettingValue, Role } from './db'

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

/** 时间重叠判定（字符串 HH:MM 比较即可，同一日） */
function overlapTime(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd
}

/** 课长时间（分钟） */
function durationMin(startTime: string, endTime: string): number {
  const toMin = (t: string): number => {
    const [h, m] = t.split(':').map(Number)
    return h * 60 + (m || 0)
  }
  return Math.max(30, toMin(endTime) - toMin(startTime))
}

interface InstanceRow {
  id: number
  course_id: number
  date: string
  start_time: string
  end_time: string
  actual_teacher_id: number | null
  status: string
  subject: string
  grade: string
  class_name: string
  default_teacher_id: number | null
  default_teacher_name: string | null
  actual_teacher_name: string | null
}

const INSTANCE_SELECT = `
  SELECT si.*, c.subject, c.grade, c.class_name, c.default_teacher_id,
         def.name AS default_teacher_name, act.name AS actual_teacher_name
  FROM schedule_instances si
  JOIN courses c ON c.id = si.course_id
  LEFT JOIN teachers def ON def.id = c.default_teacher_id
  LEFT JOIN teachers act ON act.id = si.actual_teacher_id
`

/** 课程标签 */
function label(subject: string, grade: string, className: string): string {
  return `${subject} ${grade} ${className}`
}

/** 实例的有效授课老师 id（代课优先） */
function effectiveTeacherId(row: InstanceRow): number | null {
  return row.actual_teacher_id ?? row.default_teacher_id
}

/** 某老师的已有实例（可排除指定实例与课程） */
function teacherInstances(teacherId: number, excludeInstanceId?: number, excludeCourseId?: number): InstanceRow[] {
  let sql = `${INSTANCE_SELECT} WHERE (si.actual_teacher_id = ? OR (si.actual_teacher_id IS NULL AND c.default_teacher_id = ?))`
  const params: (number | string)[] = [teacherId, teacherId]
  if (excludeInstanceId !== undefined) {
    sql += ' AND si.id != ?'
    params.push(excludeInstanceId)
  }
  if (excludeCourseId !== undefined) {
    sql += ' AND si.course_id != ?'
    params.push(excludeCourseId)
  }
  sql += ' ORDER BY si.date, si.start_time'
  return getDb('academic').prepare(sql).all(...params) as InstanceRow[]
}

/** 某学生所报课程产生的实例（排除指定实例） */
function studentInstances(studentId: number, excludeInstanceId?: number): InstanceRow[] {
  let sql = `${INSTANCE_SELECT}
    JOIN student_courses sc ON sc.course_id = si.course_id AND sc.student_id = ?
    WHERE 1=1`
  const params: (number | string)[] = [studentId]
  if (excludeInstanceId !== undefined) {
    sql += ' AND si.id != ?'
    params.push(excludeInstanceId)
  }
  sql += ' ORDER BY si.date, si.start_time'
  return getDb('academic').prepare(sql).all(...params) as InstanceRow[]
}

// ---------------------------------------------------------------------------
// 教务 Agent
// ---------------------------------------------------------------------------

/** 考勤异常提醒：连续 leave/absent 次数达到阈值 */
function attendanceAnomalyAlerts(threshold: number): AgentAlert[] {
  const alerts: AgentAlert[] = []
  const students = getDb('academic').prepare('SELECT id, name FROM students ORDER BY name').all() as {
    id: number
    name: string
  }[]
  const rows = getDb('academic')
    .prepare(
      `SELECT a.student_id, a.status, si.date
       FROM attendances a JOIN schedule_instances si ON si.id = a.schedule_instance_id
       WHERE a.status IN ('leave', 'absent')
       ORDER BY a.student_id, si.date DESC, si.start_time DESC`
    )
    .all() as { student_id: number; status: string; date: string }[]

  // 按学生分组，统计最近连续的非出勤次数
  const byStudent = new Map<number, { dates: string[] }>()
  for (const r of rows) {
    const list = byStudent.get(r.student_id) ?? { dates: [] }
    list.dates.push(r.date)
    byStudent.set(r.student_id, list)
  }
  for (const s of students) {
    const list = byStudent.get(s.id)
    if (!list || list.dates.length < threshold) continue
    alerts.push({
      id: `attendance-${s.id}`,
      type: 'warning',
      title: `考勤异常：${s.name}`,
      detail: `${s.name} 最近连续 ${list.dates.length} 次缺勤或请假（最近一次 ${list.dates[0]}），建议关注并联系家长。`,
      createdAt: format(new Date(), 'yyyy-MM-dd HH:mm')
    })
    if (alerts.length >= 20) break
  }
  return alerts
}

/** 信息补全提示：学生缺班级/未报课、老师未分配课程 */
function completenessAlerts(): AgentAlert[] {
  const alerts: AgentAlert[] = []
  const students = getDb('academic')
    .prepare(
      `SELECT s.id, s.name, s.school_class,
              (SELECT COUNT(*) FROM student_courses sc WHERE sc.student_id = s.id) AS cnt
       FROM students s ORDER BY s.name`
    )
    .all() as { id: number; name: string; school_class: string | null; cnt: number }[]
  for (const s of students) {
    if (!s.school_class) {
      alerts.push({
        id: `complete-student-class-${s.id}`,
        type: 'info',
        title: `信息补全：学生「${s.name}」未填写学校班级`,
        detail: '学校班级有助于按班级排课与沟通，建议在「学生管理」中补充。',
        createdAt: format(new Date(), 'yyyy-MM-dd HH:mm')
      })
    }
    if (s.cnt === 0) {
      alerts.push({
        id: `complete-student-course-${s.id}`,
        type: 'info',
        title: `信息补全：学生「${s.name}」尚未报任何课程`,
        detail: '未报课的学生不会出现在考勤名单中，建议在「学生管理」中为其选择所报课程。',
        createdAt: format(new Date(), 'yyyy-MM-dd HH:mm')
      })
    }
    if (alerts.length >= 20) break
  }
  const teachers = getDb('academic')
    .prepare(
      `SELECT t.id, t.name,
              (SELECT COUNT(*) FROM teacher_courses tc WHERE tc.teacher_id = t.id) AS cnt
       FROM teachers t ORDER BY t.name`
    )
    .all() as { id: number; name: string; cnt: number }[]
  for (const t of teachers) {
    if (t.cnt === 0) {
      alerts.push({
        id: `complete-teacher-${t.id}`,
        type: 'info',
        title: `信息补全：老师「${t.name}」未分配授课课程`,
        detail: '建议在「老师管理」中为其选择所教课程，便于统计与排课。',
        createdAt: format(new Date(), 'yyyy-MM-dd HH:mm')
      })
    }
    if (alerts.length >= 20) break
  }
  return alerts
}

/** 教务侧边栏提醒汇总 */
export function getAcademicAlerts(): AgentAlert[] {
  const settings = getDb('academic')
  const alerts: AgentAlert[] = []
  if ((getSettingValue('academic', 'agent_attendance_alert') ?? '1') === '1') {
    const threshold = parseInt(getSettingValue('academic', 'agent_attendance_threshold') ?? '3', 10) || 3
    alerts.push(...attendanceAnomalyAlerts(threshold))
  }
  if ((getSettingValue('academic', 'agent_completeness_hint') ?? '1') === '1') {
    alerts.push(...completenessAlerts())
  }
  void settings
  return alerts
}

/** 新增/编辑课程时的排课冲突检测（默认老师 + 未来 8 周规则生成日期） */
export function checkCourseConflict(payload: {
  courseId: number | null
  defaultTeacherId: number | null
  scheduleRule: ScheduleRule[]
}): ConflictItem[] {
  if ((getSettingValue('academic', 'agent_conflict_detect') ?? '1') !== '1') return []
  const teacherId = payload.defaultTeacherId
  if (teacherId === null || teacherId === undefined) return []
  const weeks = parseInt(getSettingValue('academic', 'schedule_weeks') ?? '8', 10) || 8
  const rules = payload.scheduleRule ?? []

  // 生成未来 N 周（日期, 起止时间）组合
  const now = new Date()
  const conflicts: ConflictItem[] = []
  for (const rule of rules) {
    // 与 schedule.ts 生成算法一致的日期推算（简化：逐日扫描未来 weeks*7 天）
    for (let d = 0; d < weeks * 7; d++) {
      const day = new Date(now.getTime() + d * 86400000)
      const weekday = day.getDay() === 0 ? 7 : day.getDay() // 1=周一…7=周日
      if (weekday !== rule.weekday) continue
      const dateStr = format(day, 'yyyy-MM-dd')
      const clash = teacherInstances(teacherId, undefined, payload.courseId ?? undefined).filter(
        (i) => i.date === dateStr && i.status !== 'cancelled' && overlapTime(rule.start, rule.end, i.start_time, i.end_time)
      )
      for (const c of clash) {
        conflicts.push({
          type: 'teacher',
          who: c.actual_teacher_name ?? c.default_teacher_name ?? '老师',
          courseLabel: label(c.subject, c.grade, c.class_name),
          date: c.date,
          startTime: c.start_time,
          endTime: c.end_time,
          reason: '时间重叠'
        })
      }
    }
  }
  return conflicts
}

/** 单次调课冲突检测（老师 + 报名学生） */
export function checkInstanceConflict(payload: {
  instanceId: number
  date: string
  startTime: string
  endTime: string
  actualTeacherId: number | null
}): ConflictItem[] {
  if ((getSettingValue('academic', 'agent_conflict_detect') ?? '1') !== '1') return []
  const inst = getDb('academic')
    .prepare(`${INSTANCE_SELECT} WHERE si.id = ?`)
    .get(payload.instanceId) as InstanceRow | undefined
  if (!inst) return []
  const conflicts: ConflictItem[] = []

  // 老师冲突
  const teacherId = payload.actualTeacherId ?? effectiveTeacherId(inst)
  if (teacherId !== null) {
    const clash = teacherInstances(teacherId, payload.instanceId).filter(
      (i) => i.date === payload.date && i.status !== 'cancelled' && overlapTime(payload.startTime, payload.endTime, i.start_time, i.end_time)
    )
    for (const c of clash) {
      conflicts.push({
        type: 'teacher',
        who: c.actual_teacher_name ?? c.default_teacher_name ?? '老师',
        courseLabel: label(c.subject, c.grade, c.class_name),
        date: c.date,
        startTime: c.start_time,
        endTime: c.end_time,
        reason: '时间重叠'
      })
    }
  }

  // 学生冲突：本课程报名学生同时报了其他课，且其他课实例与调课时间重叠
  const students = getDb('academic')
    .prepare(
      `SELECT s.id, s.name FROM student_courses sc JOIN students s ON s.id = sc.student_id WHERE sc.course_id = ?`
    )
    .all(inst.course_id) as { id: number; name: string }[]
  for (const s of students) {
    const clash = studentInstances(s.id, payload.instanceId).filter(
      (i) => i.date === payload.date && i.status !== 'cancelled' && overlapTime(payload.startTime, payload.endTime, i.start_time, i.end_time)
    )
    for (const c of clash) {
      conflicts.push({
        type: 'student',
        who: s.name,
        courseLabel: label(c.subject, c.grade, c.class_name),
        date: c.date,
        startTime: c.start_time,
        endTime: c.end_time,
        reason: `该学生同时报名了「${label(c.subject, c.grade, c.class_name)}」`
      })
    }
  }
  return conflicts
}

/** 调课替补时间段建议：未来 7 天内老师的空闲时段（8:00-22:00），返回前 3 个 */
export function suggestSlots(instanceId: number): SlotSuggestion[] {
  const inst = getDb('academic')
    .prepare(`${INSTANCE_SELECT} WHERE si.id = ?`)
    .get(instanceId) as InstanceRow | undefined
  if (!inst) return []
  const teacherId = effectiveTeacherId(inst)
  if (teacherId === null) return []
  const need = durationMin(inst.start_time, inst.end_time)
  const busy = teacherInstances(teacherId).filter(
    (i) => i.status !== 'cancelled' && i.date >= format(new Date(), 'yyyy-MM-dd')
  )

  const slots: SlotSuggestion[] = []
  const today = new Date()
  for (let d = 0; d < 7 && slots.length < 3; d++) {
    const date = format(new Date(today.getTime() + d * 86400000), 'yyyy-MM-dd')
    const dayBusy = busy
      .filter((b) => b.date === date)
      .sort((a, b) => a.start_time.localeCompare(b.start_time))
    // 从 8:00 起扫描空闲窗口
    let cursor = 8 * 60
    const windows: { start: number; end: number }[] = []
    for (const b of dayBusy) {
      const bs = toMin(b.start_time)
      const be = toMin(b.end_time)
      if (bs > cursor) windows.push({ start: cursor, end: bs })
      cursor = Math.max(cursor, be)
    }
    if (cursor < 22 * 60) windows.push({ start: cursor, end: 22 * 60 })
    for (const w of windows) {
      if (w.end - w.start >= need && slots.length < 3) {
        slots.push({
          date,
          startTime: toHHMM(w.start),
          endTime: toHHMM(Math.min(w.start + need, w.end))
        })
      }
    }
  }
  return slots
}

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + (m || 0)
}

function toHHMM(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
}

/** 相似姓名检测（去空格/全半角归一后完全一致或互相包含） */
export function checkDuplicateName(kind: 'student' | 'teacher', name: string): { matches: string[] } {
  const normalize = (s: string): string => s.replace(/\s+/g, '').trim()
  const target = normalize(name)
  if (!target) return { matches: [] }
  const table = kind === 'student' ? 'students' : 'teachers'
  const rows = getDb('academic').prepare(`SELECT name FROM ${table}`).all() as { name: string }[]
  const matches = rows.map((r) => r.name).filter((n) => {
    const nn = normalize(n)
    // 完全相同或互相包含均视为可能重复（此接口仅在新增时调用，无需排除自身）
    return nn && (nn === target || nn.includes(target) || target.includes(nn))
  })
  return { matches: [...new Set(matches)].slice(0, 5) }
}

/** 周报/月报生成（本地汇总 + 可选大模型润色） */
export async function generateReport(kind: 'week' | 'month'): Promise<GeneratedContent> {
  const db = getDb('academic')
  const today = new Date()
  const from = new Date(today.getTime() - (kind === 'week' ? 7 : 30) * 86400000)
  const to = new Date(today.getTime() + (kind === 'week' ? 7 : 30) * 86400000)
  const fromStr = format(from, 'yyyy-MM-dd')
  const toStr = format(to, 'yyyy-MM-dd')

  const stats = {
    totalInstances: (db.prepare('SELECT COUNT(*) AS c FROM schedule_instances WHERE date BETWEEN ? AND ? AND status != ?').get(fromStr, toStr, 'cancelled') as { c: number }).c,
    adjusted: (db.prepare("SELECT COUNT(*) AS c FROM schedule_instances WHERE date BETWEEN ? AND ? AND status = 'adjusted'").get(fromStr, toStr) as { c: number }).c,
    cancelled: (db.prepare("SELECT COUNT(*) AS c FROM schedule_instances WHERE date BETWEEN ? AND ? AND status = 'cancelled'").get(fromStr, toStr) as { c: number }).c,
    present: (db.prepare("SELECT COUNT(*) AS c FROM attendances a JOIN schedule_instances si ON si.id = a.schedule_instance_id WHERE si.date BETWEEN ? AND ? AND a.status = 'present'").get(fromStr, toStr) as { c: number }).c,
    leave: (db.prepare("SELECT COUNT(*) AS c FROM attendances a JOIN schedule_instances si ON si.id = a.schedule_instance_id WHERE si.date BETWEEN ? AND ? AND a.status = 'leave'").get(fromStr, toStr) as { c: number }).c,
    absent: (db.prepare("SELECT COUNT(*) AS c FROM attendances a JOIN schedule_instances si ON si.id = a.schedule_instance_id WHERE si.date BETWEEN ? AND ? AND a.status = 'absent'").get(fromStr, toStr) as { c: number }).c,
    students: (db.prepare('SELECT COUNT(*) AS c FROM students').get() as { c: number }).c,
    teachers: (db.prepare('SELECT COUNT(*) AS c FROM teachers').get() as { c: number }).c,
    courses: (db.prepare('SELECT COUNT(*) AS c FROM courses').get() as { c: number }).c
  }
  const attended = stats.present + stats.leave + stats.absent
  const rate = attended > 0 ? Math.round((stats.present / attended) * 100) : 0
  const title = kind === 'week' ? '周报' : '月报'
  const rangeText = `${fromStr} 至 ${toStr}`

  const dataText = [
    `统计周期：${rangeText}`,
    `课程总数：${stats.courses} 门；学生 ${stats.students} 人；老师 ${stats.teachers} 人`,
    `周期内课程：${stats.totalInstances} 节（调课 ${stats.adjusted} 节，取消 ${stats.cancelled} 节）`,
    `考勤：出勤 ${stats.present} 人次，请假 ${stats.leave} 人次，缺勤 ${stats.absent} 人次，出勤率 ${rate}%`,
    ''
  ].join('\n')

  const template = [
    `【Vlearn 教务${title}】`,
    `统计周期：${rangeText}`,
    '',
    `一、基本概况`,
    `课程 ${stats.courses} 门，学生 ${stats.students} 人，老师 ${stats.teachers} 人。`,
    '',
    `二、排课与考勤`,
    `周期内共 ${stats.totalInstances} 节课（调课 ${stats.adjusted} 节、取消 ${stats.cancelled} 节）；`,
    `考勤出勤 ${stats.present} 人次、请假 ${stats.leave} 人次、缺勤 ${stats.absent} 人次，出勤率 ${rate}%。`,
    '',
    `三、小结`,
    rate >= 90
      ? '整体出勤情况良好，继续保持。'
      : '近期缺勤/请假比例偏高，建议重点关注相关学生并联系家长。'
  ].join('\n')

  if (!isAIConfigured('academic')) {
    return { content: template + '\n\n（未配置大模型 API，以上为系统自动生成的模板报告）', usedAi: false }
  }
  try {
    const content = await callLLM(
      'academic',
      'report',
      '你是一名教培机构的教务主任，根据给定的统计数据撰写一份简洁、专业的教务周报/月报，使用中文，包含基本情况、数据亮点与工作建议，300 字以内。',
      `${title}数据（${dataText}）`
    )
    return { content, usedAi: true }
  } catch (err) {
    if (err instanceof AINotConfiguredError) return { content: template, usedAi: false }
    throw err
  }
}

// ---------------------------------------------------------------------------
// 财务 Agent
// ---------------------------------------------------------------------------

/** 缴费逾期预警：应缴>实缴且未来 N 天内有课的学生 */
export function getFinanceAlerts(): AgentAlert[] {
  const alerts: AgentAlert[] = []
  if ((getSettingValue('finance', 'agent_overdue_alert') ?? '1') !== '1') return alerts
  const days = parseInt(getSettingValue('finance', 'agent_overdue_days') ?? '7', 10) || 7
  const today = format(new Date(), 'yyyy-MM-dd')
  const deadline = format(new Date(Date.now() + days * 86400000), 'yyyy-MM-dd')

  const owing = getDb('finance')
    .prepare('SELECT student_id, course_id, amount_due, amount_paid FROM student_payments WHERE amount_paid < amount_due')
    .all() as { student_id: number; course_id: number; amount_due: number; amount_paid: number }[]
  const academic = getDb('academic')
  for (const o of owing) {
    const student = academic.prepare('SELECT name FROM students WHERE id = ?').get(o.student_id) as
      | { name: string }
      | undefined
    const course = academic
      .prepare('SELECT subject, grade, class_name FROM courses WHERE id = ?')
      .get(o.course_id) as { subject: string; grade: string; class_name: string } | undefined
    if (!student || !course) continue
    const upcoming = academic
      .prepare(
        `SELECT COUNT(*) AS c FROM schedule_instances WHERE course_id = ? AND status != 'cancelled' AND date BETWEEN ? AND ?`
      )
      .get(o.course_id, today, deadline) as { c: number }
    if (upcoming.c === 0) continue
    const diff = Math.round((o.amount_due - o.amount_paid) * 100) / 100
    alerts.push({
      id: `overdue-${o.student_id}-${o.course_id}`,
      type: 'warning',
      title: `缴费逾期预警：${student.name}`,
      detail: `${student.name} 在「${label(course.subject, course.grade, course.class_name)}」尚有 ¥${diff.toFixed(2)} 未缴，未来 ${days} 天内还有 ${upcoming.c} 次课。`,
      createdAt: format(new Date(), 'yyyy-MM-dd HH:mm')
    })
    if (alerts.length >= 10) break
  }
  return alerts
}

/** 对账检查（按钮触发）：应缴 vs 实缴、应付 vs 实付差异清单 */
export function reconcile(): ReconcileResult {
  const finance = getDb('finance')
  const academic = getDb('academic')
  const items: ReconcileResult['items'] = []

  const studentRows = finance
    .prepare(
      'SELECT id, student_id, course_id, amount_due AS due, amount_paid AS paid, payment_date AS date, note FROM student_payments'
    )
    .all() as { id: number; student_id: number; course_id: number; due: number; paid: number; date: string; note: string | null }[]
  for (const r of studentRows) {
    const due = Math.round(r.due * 100) / 100
    const paid = Math.round(r.paid * 100) / 100
    if (due === paid) continue
    const student = academic.prepare('SELECT name FROM students WHERE id = ?').get(r.student_id) as
      | { name: string }
      | undefined
    const course = academic
      .prepare('SELECT subject, grade, class_name FROM courses WHERE id = ?')
      .get(r.course_id) as { subject: string; grade: string; class_name: string } | undefined
    items.push({
      kind: 'student',
      name: student?.name ?? `学生#${r.student_id}`,
      courseLabel: course ? label(course.subject, course.grade, course.class_name) : `课程#${r.course_id}`,
      due,
      paid,
      diff: Math.round((paid - due) * 100) / 100,
      date: r.date,
      note: r.note
    })
  }

  const teacherRows = finance
    .prepare(
      'SELECT id, teacher_id, schedule_instance_id, amount_due AS due, amount_paid AS paid, payment_date AS date, note FROM teacher_payments'
    )
    .all() as {
    id: number
    teacher_id: number
    schedule_instance_id: number
    due: number
    paid: number
    date: string
    note: string | null
  }[]
  for (const r of teacherRows) {
    const due = Math.round(r.due * 100) / 100
    const paid = Math.round(r.paid * 100) / 100
    if (due === paid) continue
    const teacher = academic.prepare('SELECT name FROM teachers WHERE id = ?').get(r.teacher_id) as
      | { name: string }
      | undefined
    const si = academic
      .prepare(`${INSTANCE_SELECT} WHERE si.id = ?`)
      .get(r.schedule_instance_id) as InstanceRow | undefined
    items.push({
      kind: 'teacher',
      name: teacher?.name ?? `老师#${r.teacher_id}`,
      courseLabel: si ? `${si.date} ${label(si.subject, si.grade, si.class_name)}` : `课次#${r.schedule_instance_id}`,
      due,
      paid,
      diff: Math.round((paid - due) * 100) / 100,
      date: r.date,
      note: r.note
    })
  }

  const studentCount = items.filter((i) => i.kind === 'student').length
  const teacherCount = items.filter((i) => i.kind === 'teacher').length
  const totalDiff = Math.round(items.reduce((s, i) => s + i.diff, 0) * 100) / 100
  const summary =
    items.length === 0
      ? '对账通过：所有缴费/课酬记录的应缴与实缴、应付与实付金额均一致。'
      : `共发现 ${items.length} 项差异（学生缴费 ${studentCount} 项、老师课酬 ${teacherCount} 项），差额合计 ¥${totalDiff.toFixed(2)}（正数表示多缴/多付，负数表示欠款）。请逐项核对下方清单。`
  return { items, studentCount, teacherCount, totalDiff, summary }
}

/** 异常交易检测（新增/修改缴费或支付记录时触发） */
export function checkPaymentAnomaly(payload: {
  kind: 'student' | 'teacher'
  id?: number
  amountPaid: number
  amountDue: number
}): AnomalyCheckResult {
  const anomalies: { level: 'warning'; message: string }[] = []
  if ((getSettingValue('finance', 'agent_anomaly_detect') ?? '1') !== '1') return { anomalies }
  const multiplier = parseFloat(getSettingValue('finance', 'agent_anomaly_multiplier') ?? '3') || 3
  const table = payload.kind === 'student' ? 'student_payments' : 'teacher_payments'
  const finance = getDb('finance')

  // 金额超过平均值 N 倍
  const avg = (
    finance
      .prepare(`SELECT AVG(amount_paid) AS a FROM ${table} WHERE id != ?`)
      .get(payload.id ?? -1) as { a: number | null }
  ).a
  if (avg !== null && avg > 0 && payload.amountPaid > avg * multiplier) {
    anomalies.push({
      level: 'warning',
      message: `该笔金额 ¥${payload.amountPaid.toFixed(2)} 超过历史平均实缴/实付（¥${avg.toFixed(2)}）的 ${multiplier} 倍，请确认金额无误。`
    })
  }
  // 实缴远大于应缴（超过应缴 2 倍且差额 > 100 元）
  if (payload.amountDue > 0 && payload.amountPaid > payload.amountDue * 2 && payload.amountPaid - payload.amountDue > 100) {
    anomalies.push({
      level: 'warning',
      message: `实缴/实付金额（¥${payload.amountPaid.toFixed(2)}）远大于应缴/应付（¥${payload.amountDue.toFixed(2)}），请确认是否为重复缴费或金额录入错误。`
    })
  }
  // 频繁修改同一记录（仅编辑时）
  if (payload.id !== undefined && payload.id > 0) {
    const row = finance
      .prepare(`SELECT edits_count FROM ${table} WHERE id = ?`)
      .get(payload.id) as { edits_count: number } | undefined
    if (row && row.edits_count >= 3) {
      anomalies.push({
        level: 'warning',
        message: `该记录已被修改 ${row.edits_count} 次，请确认是否存在反复改动或数据被误操作。`
      })
    }
  }
  return { anomalies }
}

/** 盈亏趋势分析（近 12 个月 + 未来 3 个月预测） */
export async function trendAnalysis(): Promise<GeneratedContent> {
  const finance = getDb('finance')
  const year = new Date().getFullYear()
  const incomeRows = finance
    .prepare(
      `SELECT substr(payment_date, 1, 7) AS m, SUM(amount_paid) AS s FROM student_payments GROUP BY m ORDER BY m`
    )
    .all() as { m: string; s: number }[]
  const expenseRows = finance
    .prepare(
      `SELECT substr(payment_date, 1, 7) AS m, SUM(amount_paid) AS s FROM teacher_payments GROUP BY m ORDER BY m`
    )
    .all() as { m: string; s: number }[]

  const incomeMap = new Map(incomeRows.map((r) => [r.m, r.s]))
  const expenseMap = new Map(expenseRows.map((r) => [r.m, r.s]))
  const months: { month: string; income: number; expense: number; profit: number }[] = []
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${String(m).padStart(2, '0')}`
    const income = incomeMap.get(key) ?? 0
    const expense = expenseMap.get(key) ?? 0
    months.push({ month: key, income, expense, profit: Math.round((income - expense) * 100) / 100 })
  }
  const recent = months.filter((x) => x.income + x.expense > 0)
  const last3 = recent.slice(-3)
  const avgIncome = last3.length ? last3.reduce((s, x) => s + x.income, 0) / last3.length : 0
  const avgExpense = last3.length ? last3.reduce((s, x) => s + x.expense, 0) / last3.length : 0
  const nextMonths = [1, 2, 3].map((i) => {
    const d = new Date()
    const projected = new Date(d.getFullYear(), d.getMonth() + i, 1)
    return `${projected.getFullYear()}-${String(projected.getMonth() + 1).padStart(2, '0')}`
  })

  const dataText = months
    .filter((x) => x.income + x.expense > 0)
    .map((x) => `${x.month}：收入 ¥${x.income.toFixed(2)}，支出 ¥${x.expense.toFixed(2)}，盈亏 ¥${x.profit.toFixed(2)}`)
    .join('\n')
  const projectionText = nextMonths
    .map((m, i) => `${m}（预测）：收入约 ¥${avgIncome.toFixed(2)}，支出约 ¥${avgExpense.toFixed(2)}，盈亏约 ¥${(avgIncome - avgExpense).toFixed(2)}${i === 0 ? '（基于近 3 个月平均值推算）' : ''}`)
    .join('\n')

  const template = [
    '【Vlearn 盈亏趋势分析】',
    '',
    '一、历史数据',
    dataText || '（暂无历史数据）',
    '',
    '二、未来 3 个月预测',
    projectionText,
    '',
    '三、提示',
    '以上预测基于历史平均值线性推算，未考虑招生变化、调价等因素，仅供参考。'
  ].join('\n')

  if (!isAIConfigured('finance')) {
    return { content: template + '\n\n（未配置大模型 API，以上为系统自动生成的模板分析）', usedAi: false }
  }
  try {
    const content = await callLLM(
      'finance',
      'trend',
      '你是一名教培机构的财务分析师，根据给出的月度收入/支出/盈亏数据，输出 300 字以内的中文趋势分析：概括现状、指出值得关注的风险点、给出 2-3 条经营建议。',
      `历史月度数据：\n${dataText || '无'}\n\n系统预测：\n${projectionText}`
    )
    return { content, usedAi: true }
  } catch (err) {
    if (err instanceof AINotConfiguredError) return { content: template, usedAi: false }
    throw err
  }
}

/** 智能报表/凭证生成（基于当前筛选结果；已配大模型时附加 AI 分析备注） */
export async function smartReport(
  module: string,
  columns: { header: string; key: string }[],
  rows: Record<string, unknown>[]
): Promise<GeneratedContent> {
  const numericKeys = columns
    .map((c) => c.key)
    .filter((k) => rows.length > 0 && typeof rows[0][k] === 'number')
  const totals = numericKeys.map((k) => `${k} 合计 ¥${rows.reduce((s, r) => s + (Number(r[k]) || 0), 0).toFixed(2)}`)

  const lines: string[] = [
    `【${module}】`,
    `生成时间：${format(new Date(), 'yyyy-MM-dd HH:mm')}`,
    `记录数：${rows.length} 条`,
    ''
  ]
  for (const r of rows.slice(0, 200)) {
    lines.push(columns.map((c) => `${c.header}：${r[c.key] ?? '—'}`).join('；'))
  }
  if (rows.length > 200) lines.push(`……（其余 ${rows.length - 200} 条省略，导出 Excel 查看完整数据）`)
  if (totals.length > 0) lines.push('', totals.join('；'))
  let content = lines.join('\n')

  if (isAIConfigured('finance')) {
    try {
      const note = await callLLM(
        'finance',
        'voucher',
        '你是一名教培机构财务，基于给定报表数据，用中文给出 100 字以内的简要点评（金额核对提示或异常提醒）。',
        lines.join('\n')
      )
      content += `\n\n【智能点评】${note}`
      return { content, usedAi: true }
    } catch (err) {
      if (err instanceof AINotConfiguredError) return { content, usedAi: false }
      throw err
    }
  }
  return { content, usedAi: false }
}

/** 供 ipcHandlers 引用角色类型 */
export type { Role }
