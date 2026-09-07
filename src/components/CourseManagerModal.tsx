/**
 * 课程管理弹窗（从课程日历页工具栏进入）：
 * - 课程列表：科目、年级、班级号、默认老师、上课时间规则
 * - 新增课程后自动按时间规则生成未来 N 周课程实例
 * - 修改规则不会自动更新已生成实例，可手动"重新生成排课"（保留历史）
 */
import { DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons'
import { App as AntdApp, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, TimePicker } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, getErrorMessage, tryApi } from '../api'
import type { Course, ScheduleRule, Teacher } from '../types'

const WEEKDAY_OPTIONS = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 7, label: '周日' }
]

const weekdayLabel = (w: number): string => WEEKDAY_OPTIONS.find((o) => o.value === w)?.label ?? `周${w}`

/** 规则展示文本："每周二 15:00-17:00、每周六 09:00-11:00" */
function ruleText(rules: ScheduleRule[]): string {
  if (!rules || rules.length === 0) return '—'
  return rules.map((r) => `每${weekdayLabel(r.weekday)} ${r.start}-${r.end}`).join('、')
}

interface CourseManagerModalProps {
  open: boolean
  onClose: () => void
  /** 课程数据发生变化（日历需刷新） */
  onChanged: () => void
}

export default function CourseManagerModal({ open, onClose, onChanged }: CourseManagerModalProps): JSX.Element {
  const { message } = AntdApp.useApp()
  const [courses, setCourses] = useState<Course[]>([])
  const [teachers, setTeachers] = useState<Teacher[]>([])
  const [grades, setGrades] = useState<string[]>(['高一', '高二', '高三'])
  const [loading, setLoading] = useState(false)
  /** 表单弹窗：null 关闭，否则为新增/编辑 */
  const [editing, setEditing] = useState<Course | 'new' | null>(null)
  const [form] = Form.useForm()
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, t, s] = await Promise.all([api.getCourses(), api.getTeachers(), api.getSettings()])
      setCourses(c)
      setTeachers(t)
      setGrades(s.grades)
    } catch (err) {
      message.error(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [message])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  const openCreate = (): void => {
    setEditing('new')
    form.resetFields()
    form.setFieldsValue({ scheduleRule: [{ weekday: 2, start: dayjs('15:00', 'HH:mm'), end: dayjs('17:00', 'HH:mm') }] })
  }

  const openEdit = (course: Course): void => {
    setEditing(course)
    form.resetFields()
    form.setFieldsValue({
      subject: course.subject,
      grade: course.grade,
      className: course.className,
      defaultTeacherId: course.defaultTeacherId ?? undefined,
      scheduleRule: course.scheduleRule.map((r) => ({
        weekday: r.weekday,
        time: [dayjs(`2000-01-01 ${r.start}`, 'YYYY-MM-DD HH:mm'), dayjs(`2000-01-01 ${r.end}`, 'YYYY-MM-DD HH:mm')]
      }))
    })
  }

  const handleSave = async (): Promise<void> => {
    try {
      const values = await form.validateFields()
      const scheduleRule: ScheduleRule[] = ((values.scheduleRule ?? []) as { weekday: number; time: [Dayjs, Dayjs] }[]).map(
        (r) => ({
          weekday: r.weekday,
          start: r.time[0].format('HH:mm'),
          end: r.time[1].format('HH:mm')
        })
      )
      const payload = {
        subject: values.subject.trim(),
        grade: values.grade,
        className: values.className.trim(),
        defaultTeacherId: values.defaultTeacherId ?? null,
        scheduleRule
      }
      setSaving(true)
      if (editing === 'new') {
        const result = await tryApi(() => api.createCourse(payload))
        if (!result.ok) throw new Error(result.error)
        message.success(`课程已创建，并按规则自动生成了未来 8 周的排课`)
      } else if (editing) {
        const result = await tryApi(() => api.updateCourse(editing.id, payload))
        if (!result.ok) throw new Error(result.error)
        message.success('课程已保存。如需按新规则重新排课，请点击「重新生成排课」')
      }
      setEditing(null)
      await load()
      onChanged()
    } catch (err) {
      if (err instanceof Error && err.message) message.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleRegenerate = async (course: Course): Promise<void> => {
    try {
      const n = await api.regenerateInstances(course.id)
      message.success(`已删除未来实例并按当前规则重新生成 ${n} 节课（历史记录保留）`)
      onChanged()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const handleDelete = async (course: Course): Promise<void> => {
    try {
      await api.deleteCourse(course.id)
      message.success('课程已删除')
      await load()
      onChanged()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const columns = useMemo(
    () => [
      { title: '科目', dataIndex: 'subject', key: 'subject', width: 90 },
      { title: '年级', dataIndex: 'grade', key: 'grade', width: 80 },
      { title: '班级号', dataIndex: 'className', key: 'className', width: 100 },
      {
        title: '默认授课老师',
        key: 'teacher',
        width: 120,
        render: (_: unknown, row: Course) => row.defaultTeacherName || '—'
      },
      {
        title: '默认上课时间规则',
        key: 'rule',
        render: (_: unknown, row: Course) => ruleText(row.scheduleRule)
      },
      {
        title: '操作',
        key: 'actions',
        width: 240,
        render: (_: unknown, row: Course) => (
          <Space size={4}>
            <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>
              编辑
            </Button>
            <Popconfirm
              title="重新生成排课？"
              description="将删除该课程今天及以后的课程实例，并按当前规则重新生成。历史（过去的）记录不受影响。"
              okText="重新生成"
              cancelText="取消"
              onConfirm={() => handleRegenerate(row)}
            >
              <Button size="small" icon={<ReloadOutlined />}>
                重新生成排课
              </Button>
            </Popconfirm>
            <Popconfirm
              title="确认删除该课程？"
              description="将同时删除其全部排课、考勤与财务记录，且不可恢复。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => handleDelete(row)}
            >
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </Space>
        )
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [courses]
  )

  return (
    <Modal open={open} onCancel={onClose} footer={null} width={960} title="课程管理">
      <div style={{ marginBottom: 12, textAlign: 'right' }}>
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
          新增课程
        </Button>
      </div>
      <Table
        size="small"
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={courses}
        pagination={false}
        scroll={{ y: 420 }}
        locale={{ emptyText: '暂无课程，点击右上角「新增课程」创建' }}
      />

      {/* 新增/编辑课程表单 */}
      <Modal
        open={editing !== null}
        title={editing === 'new' ? '新增课程' : '编辑课程'}
        okText="保存"
        cancelText="取消"
        confirmLoading={saving}
        onOk={handleSave}
        onCancel={() => setEditing(null)}
        width={640}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item name="subject" label="科目" rules={[{ required: true, message: '请输入科目，如"数学"' }]}>
            <Input placeholder="如：数学" />
          </Form.Item>
          <Form.Item name="grade" label="年级" rules={[{ required: true, message: '请选择年级' }]}>
            <Select
              placeholder="请选择年级"
              options={grades.map((g) => ({ value: g, label: g }))}
            />
          </Form.Item>
          <Form.Item name="className" label="班级号" rules={[{ required: true, message: '请输入班级号' }]}>
            <Input placeholder="如：A1班" />
          </Form.Item>
          <Form.Item name="defaultTeacherId" label="默认授课老师">
            <Select
              allowClear
              placeholder="可稍后指定"
              options={teachers.map((t) => ({ value: t.id, label: t.name }))}
            />
          </Form.Item>
          <Form.Item label="默认上课时间规则" required style={{ marginBottom: 0 }}>
            <Form.List
              name="scheduleRule"
              rules={[{ validator: async (_, value) => {
                if (!value || value.length === 0) throw new Error('请至少添加一条上课时间规则')
              } }]}
            >
              {(fields, { add, remove }, { errors }) => (
                <>
                  {fields.map((field) => (
                    <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 8 }}>
                      <Form.Item name={[field.name, 'weekday']} rules={[{ required: true, message: '选星期' }]} noStyle>
                        <Select style={{ width: 100 }} placeholder="星期" options={WEEKDAY_OPTIONS} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'time']} rules={[{ required: true, message: '选时间' }]} noStyle>
                        <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
                      </Form.Item>
                      {fields.length > 1 && (
                        <Button type="text" danger onClick={() => remove(field.name)}>
                          删除
                        </Button>
                      )}
                    </Space>
                  ))}
                  <Button type="dashed" icon={<PlusOutlined />} onClick={() => add({ weekday: 2, time: [dayjs('15:00', 'HH:mm'), dayjs('17:00', 'HH:mm')] })}>
                    添加时间段
                  </Button>
                  <Form.ErrorList errors={errors} />
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>
    </Modal>
  )
}
