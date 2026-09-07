/**
 * 考勤状态标签：出勤（绿）/ 请假（橙）/ 缺勤（红）。
 */
import { Tag } from 'antd'
import type { AttendanceStatus } from '../types'

const STATUS_MAP: Record<AttendanceStatus, { color: string; text: string }> = {
  present: { color: 'success', text: '出勤' },
  leave: { color: 'warning', text: '请假' },
  absent: { color: 'error', text: '缺勤' }
}

export function attendanceStatusText(status: AttendanceStatus | null | undefined): string {
  return status ? STATUS_MAP[status].text : '未标记'
}

export default function AttendanceStatusTag({ status }: { status: AttendanceStatus | null | undefined }): JSX.Element {
  if (!status) return <Tag>未标记</Tag>
  const info = STATUS_MAP[status]
  return <Tag color={info.color}>{info.text}</Tag>
}
