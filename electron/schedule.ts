/**
 * 排课生成逻辑：根据课程默认时间规则，在未来 N 周内生成课程实例。
 * 使用 date-fns 处理日期。weekday 约定与 date-fns 的 getISODay 一致：1=周一 … 7=周日。
 */
import type { Database } from 'better-sqlite3'
import { addWeeks, format, nextDay, startOfDay } from 'date-fns'
import type { Day } from 'date-fns'
import type { ScheduleRule } from '../src/types'

/**
 * 将业务 weekday（1=周一 … 7=周日）转换为 date-fns 的 Day 枚举（0=周日 … 6=周六）。
 */
function toDateFnsDay(weekday: number): Day {
  return (weekday % 7) as Day
}

/**
 * 为课程生成课程实例（跳过与已有实例日期+时间完全相同的记录）。
 * @param database 数据库连接
 * @param courseId 课程 id
 * @param rules 时间规则数组
 * @param fromDate 起始日期（含），从该日起找每个规则的下一次上课日
 * @param weeks 生成周数
 * @param syncOrigin 校区标识（多校区同步用，可选）
 * @returns 实际插入的实例数量
 */
export function generateInstances(
  database: Database,
  courseId: number,
  rules: ScheduleRule[],
  fromDate: Date,
  weeks: number,
  syncOrigin?: string
): number {
  const insert = database.prepare(`
    INSERT INTO schedule_instances (course_id, date, start_time, end_time, status, sync_origin)
    VALUES (?, ?, ?, ?, 'normal', ?)
  `)
  const exists = database.prepare(`
    SELECT 1 FROM schedule_instances
    WHERE course_id = ? AND date = ? AND start_time = ? AND end_time = ?
  `)

  const tx = database.transaction(() => {
    let count = 0
    const from = startOfDay(fromDate)
    for (let w = 0; w < weeks; w++) {
      for (const rule of rules) {
        if (rule.weekday < 1 || rule.weekday > 7) continue
        // 从起始日找该星期几的下一次出现，再逐周递推
        const first = nextDay(from, toDateFnsDay(rule.weekday))
        const date = addWeeks(first, w)
        const dateStr = format(date, 'yyyy-MM-dd')
        if (exists.get(courseId, dateStr, rule.start, rule.end)) continue
        insert.run(courseId, dateStr, rule.start, rule.end, syncOrigin ?? null)
        count++
      }
    }
    return count
  })

  return tx()
}
