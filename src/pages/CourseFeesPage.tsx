/**
 * 课程费用设置（仅财务可见页面）：
 * - 课程列表展示科目 / 年级 / 班级号 / 默认老师 / 单次课酬 / 课程费用
 * - 单次课酬（元/次）与课程费用（元/次课）支持行内编辑：点"编辑"进入草稿态，
 *   点"保存"调用 updateCourseFees 持久化，"取消"丢弃草稿
 * - 支持导出 Excel（module="课程费用"）
 */
import { EditOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, InputNumber, Space, Table, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage, tryApi } from '../api'
import ExportExcelButton from '../components/ExportExcelButton'
import PageToolbar from '../components/PageToolbar'
import type { Course } from '../types'

/** 某一行正在编辑的草稿值（金额单位：元） */
interface FeeDraft {
  fee: number
  payPerSession: number
}

/** 金额展示：四舍五入到分后以 ¥ 前缀展示 */
const fmtMoney = (v: number): string => `¥${(Math.round(v * 100) / 100).toFixed(2)}`

export default function CourseFeesPage(): JSX.Element {
  const { message } = AntdApp.useApp()
  const [courses, setCourses] = useState<Course[]>([])
  const [loading, setLoading] = useState(false)
  /** 正在行内编辑的课程 id，null 表示未在编辑 */
  const [editingId, setEditingId] = useState<number | null>(null)
  /** 各行的编辑草稿值（未提交前不写回数据源） */
  const [drafts, setDrafts] = useState<Map<number, FeeDraft>>(new Map())
  /** 正在保存的课程 id（用于按钮 loading） */
  const [savingId, setSavingId] = useState<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const rows = await api.getFinanceCourses()
      setCourses(rows)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    void load()
  }, [load])

  /** 开始编辑某行：以该行原值初始化草稿 */
  const startEdit = (course: Course): void => {
    setEditingId(course.id)
    setDrafts((prev) => {
      const next = new Map(prev)
      next.set(course.id, { fee: course.fee, payPerSession: course.payPerSession })
      return next
    })
  }

  /** 更新草稿中的单个字段 */
  const updateDraft = (courseId: number, patch: Partial<FeeDraft>): void => {
    setDrafts((prev) => {
      const current = prev.get(courseId)
      if (!current) return prev
      const next = new Map(prev)
      next.set(courseId, { ...current, ...patch })
      return next
    })
  }

  /** 保存当前行的费用修改 */
  const handleSave = async (course: Course): Promise<void> => {
    const draft = drafts.get(course.id)
    if (!draft) return
    setSavingId(course.id)
    const res = await tryApi(() =>
      api.updateCourseFees(course.id, { fee: draft.fee, payPerSession: draft.payPerSession })
    )
    if (!res.ok) {
      message.error(res.error)
      setSavingId(null)
      return
    }
    message.success('费用已保存')
    setEditingId(null)
    setSavingId(null)
    await load()
  }

  /** 取消编辑：丢弃草稿并退出编辑态 */
  const handleCancel = (courseId: number): void => {
    setDrafts((prev) => {
      if (!prev.has(courseId)) return prev
      const next = new Map(prev)
      next.delete(courseId)
      return next
    })
    setEditingId((prev) => (prev === courseId ? null : prev))
  }

  const exportRows = courses.map((c) => ({
    科目: c.subject,
    年级: c.grade,
    班级号: c.className,
    默认老师: c.defaultTeacherName ?? '',
    单次课酬: c.payPerSession,
    课程费用: c.fee
  }))

  const columns = [
    { title: '科目', dataIndex: 'subject', key: 'subject', width: 120 },
    { title: '年级', dataIndex: 'grade', key: 'grade', width: 100 },
    { title: '班级号', dataIndex: 'className', key: 'className', width: 120 },
    {
      title: '默认授课老师',
      dataIndex: 'defaultTeacherName',
      key: 'defaultTeacherName',
      width: 140,
      render: (v: string | null | undefined) => v || '—'
    },
    {
      title: '单次课酬（元/次）',
      key: 'payPerSession',
      width: 180,
      render: (_: unknown, row: Course) =>
        editingId === row.id ? (
          <InputNumber
            min={0}
            precision={2}
            prefix="¥"
            style={{ width: 140 }}
            value={drafts.get(row.id)?.payPerSession ?? row.payPerSession}
            onChange={(v) => updateDraft(row.id, { payPerSession: v ?? 0 })}
          />
        ) : (
          fmtMoney(row.payPerSession)
        )
    },
    {
      title: '课程费用（元/次课）',
      key: 'fee',
      width: 180,
      render: (_: unknown, row: Course) =>
        editingId === row.id ? (
          <InputNumber
            min={0}
            precision={2}
            prefix="¥"
            style={{ width: 140 }}
            value={drafts.get(row.id)?.fee ?? row.fee}
            onChange={(v) => updateDraft(row.id, { fee: v ?? 0 })}
          />
        ) : (
          fmtMoney(row.fee)
        )
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, row: Course) =>
        editingId === row.id ? (
          <Space size={4}>
            <Button
              size="small"
              type="primary"
              loading={savingId === row.id}
              disabled={savingId !== null && savingId !== row.id}
              onClick={() => void handleSave(row)}
            >
              保存
            </Button>
            <Button size="small" disabled={savingId !== null} onClick={() => handleCancel(row.id)}>
              取消
            </Button>
          </Space>
        ) : (
          <Button size="small" icon={<EditOutlined />} onClick={() => startEdit(row)}>
            编辑
          </Button>
        )
    }
  ]

  return (
    <div>
      <PageToolbar
        title="课程费用"
        actions={
          <ExportExcelButton
            module="课程费用"
            columns={[
              { header: '科目', key: '科目' },
              { header: '年级', key: '年级' },
              { header: '班级号', key: '班级号' },
              { header: '默认老师', key: '默认老师' },
              { header: '单次课酬', key: '单次课酬' },
              { header: '课程费用', key: '课程费用' }
            ]}
            rows={exportRows}
            disabled={courses.length === 0}
          />
        }
      />

      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        课程费用用于计算学生应缴：应缴金额 = 课程费用 × 计费出勤次数（出勤计费，缺勤是否收费由系统设置决定，请假免费）；
        单次课酬用于"自动计算应付"生成老师课酬。金额单位：元。
      </Typography.Paragraph>

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={courses}
        pagination={false}
      />
    </div>
  )
}
