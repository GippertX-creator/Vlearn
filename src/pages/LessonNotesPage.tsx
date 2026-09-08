/**
 * 助教·课程内容记录列表页：
 * - 展示近 60 天至未来 30 天内的课程实例及其"是否已记录"状态
 * - 点击"填写记录 / 查看编辑"打开 LessonNoteEditorModal，填写本次课的知识点、课堂表现、
 *   作业与总结，并可一键生成微信群短信（自动存入历史消息）
 * - 已取消（status='cancelled'）的实例不显示；按日期倒序排列
 */
import { EditOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, Space, Table, Tag, Typography } from 'antd'
import dayjs from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage } from '../api'
import LessonNoteEditorModal from '../components/LessonNoteEditorModal'
import PageToolbar from '../components/PageToolbar'
import type { LessonNote, ScheduleInstance } from '../types'

export default function LessonNotesPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  /** 时间范围内的课程实例（含课程与老师联表字段） */
  const [instances, setInstances] = useState<ScheduleInstance[]>([])
  /** 助教库中已保存的课程记录 */
  const [notes, setNotes] = useState<LessonNote[]>([])
  const [loading, setLoading] = useState(false)
  /** 当前打开记录弹窗的课程实例 id（null 关闭） */
  const [editingId, setEditingId] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      // 范围：今天前 60 天 ～ 今天后 30 天
      const today = dayjs()
      const start = today.subtract(60, 'day').format('YYYY-MM-DD')
      const end = today.add(30, 'day').format('YYYY-MM-DD')
      const [instList, noteList] = await Promise.all([api.getInstances(start, end), api.listLessonNotes()])
      setInstances(instList)
      setNotes(noteList)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  /** 课程实例 id -> 已保存记录，便于行内判断状态 */
  const noteByInstance = useMemo(
    () => new Map(notes.map((n) => [n.scheduleInstanceId, n] as const)),
    [notes]
  )

  /** 过滤掉已取消的实例，按日期倒序（同日按开始时间倒序）排列 */
  const rows = useMemo(
    () =>
      instances
        .filter((i) => i.status !== 'cancelled')
        .sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime)),
    [instances]
  )

  /** 记录状态列：已记录显示绿色 Tag + 更新时间；未记录显示灰色 Tag */
  const renderRecordStatus = (row: ScheduleInstance): JSX.Element => {
    const note = noteByInstance.get(row.id)
    if (!note) return <Tag>未记录</Tag>
    return (
      <Space size={6}>
        <Tag color="green">已记录</Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {note.updatedAt.slice(0, 16)}
        </Typography.Text>
      </Space>
    )
  }

  const columns = [
    { title: '日期', dataIndex: 'date', key: 'date', width: 110 },
    {
      title: '时间',
      key: 'time',
      width: 130,
      render: (_: unknown, row: ScheduleInstance) => `${row.startTime}-${row.endTime}`
    },
    {
      title: '课程',
      key: 'course',
      width: 220,
      render: (_: unknown, row: ScheduleInstance) =>
        [row.subject, row.grade, row.className].filter(Boolean).join(' ') || '—'
    },
    {
      title: '授课老师',
      key: 'teacher',
      width: 120,
      render: (_: unknown, row: ScheduleInstance) =>
        row.actualTeacherName ?? row.defaultTeacherName ?? <span style={{ color: '#999' }}>—</span>
    },
    { title: '记录状态', key: 'status', width: 160, render: (_: unknown, row: ScheduleInstance) => renderRecordStatus(row) },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_: unknown, row: ScheduleInstance) => (
        <Button
          size="small"
          type={noteByInstance.has(row.id) ? 'default' : 'primary'}
          icon={<EditOutlined />}
          onClick={() => setEditingId(row.id)}
        >
          {noteByInstance.has(row.id) ? '查看编辑' : '填写记录'}
        </Button>
      )
    }
  ]

  return (
    <div>
      <PageToolbar title="课程内容记录" />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        点击「填写记录」记录本次课的知识点、课堂表现、作业与总结，并可一键生成微信群短信。
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={rows}
        pagination={{ pageSize: 15, showTotal: (total) => `共 ${total} 次课程` }}
      />

      <LessonNoteEditorModal
        scheduleInstanceId={editingId}
        onClose={() => setEditingId(null)}
        onChanged={load}
      />
    </div>
  )
}
