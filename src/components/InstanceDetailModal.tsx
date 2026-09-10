/**
 * 课程实例详情弹窗（v2 角色适配）：
 * - 教务：可操作考勤（出勤/请假/缺勤 + 一键全部出勤）、单次调课（含冲突检测与
 *   智能推荐时间段）、取消/恢复本次课
 * - 助教：只读查看学生名单与考勤状态，提供"课程内容记录"入口（记录与短信生成）
 * - 考勤变更后触发 vlearn:refresh-alerts 事件，让右侧助手面板立即刷新提醒
 */
import {
  CheckCircleOutlined,
  BulbOutlined,
  CloseCircleOutlined,
  EditOutlined,
  RollbackOutlined,
  ScheduleOutlined
} from '@ant-design/icons'
import {
  App as AntdApp,
  Button,
  DatePicker,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  TimePicker
} from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import { useRole } from '../roleContext'
import type { AttendanceStatus, Classroom, ConflictItem, InstanceDetail, ScheduleInstance, SlotSuggestion, Teacher } from '../types'
import AttendanceStatusTag from './AttendanceStatusTag'
import ExportExcelButton from './ExportExcelButton'
import LessonNoteEditorModal from './LessonNoteEditorModal'

interface InstanceDetailModalProps {
  instanceId: number | null
  onClose: () => void
  onChanged: () => void
}

/** 实例状态标签 */
function StatusTag({ status }: { status: ScheduleInstance['status'] }): JSX.Element {
  if (status === 'adjusted') return <Tag color="orange">已调课</Tag>
  if (status === 'cancelled') return <Tag color="default">已取消</Tag>
  return <Tag color="blue">正常</Tag>
}

/** 冲突清单内容 */
function ConflictList({ conflicts }: { conflicts: ConflictItem[] }): JSX.Element {
  return (
    <div>
      <p style={{ color: '#fa8c16' }}>检测到以下时间冲突：</p>
      <ul style={{ paddingLeft: 20, maxHeight: 220, overflow: 'auto' }}>
        {conflicts.map((c, i) => (
          <li key={i}>
            {c.type === 'classroom' ? (
              <>
                教室「{c.who}」在 {c.date} {c.startTime}-{c.endTime} 已被「{c.courseLabel}」占用
              </>
            ) : (
              <>
                {c.type === 'teacher' ? '老师' : '学生'}「{c.who}」在 {c.date} {c.startTime}-{c.endTime} 已有
                「{c.courseLabel}」的课程
              </>
            )}
          </li>
        ))}
      </ul>
      <p>是否仍然保存？</p>
    </div>
  )
}

/**
 * 调课可选教室下拉选项（v4）：按校区分组。
 * 维护中/停用的教室置灰展示（附「维护/停用」后缀，便于显示实例当前已选教室），不可选择。
 */
function classroomOptions(classrooms: Classroom[]): { label: string; options: { value: number; label: string; disabled?: boolean }[] }[] {
  const byCampus = new Map<number, { name: string; rooms: Classroom[] }>()
  for (const r of classrooms) {
    const g = byCampus.get(r.campusId) ?? { name: r.campusName, rooms: [] }
    g.rooms.push(r)
    byCampus.set(r.campusId, g)
  }
  return [...byCampus.values()].map(({ name, rooms }) => ({
    label: name,
    options: rooms.map((r) => ({
      value: r.id,
      label: r.status === 'available' ? r.name : `${r.name}（维护/停用）`,
      disabled: r.status !== 'available'
    }))
  }))
}

export default function InstanceDetailModal({ instanceId, onClose, onChanged }: InstanceDetailModalProps): JSX.Element {
  const { message } = AntdApp.useApp()
  const role = useRole()
  /** 助教为只读模式 */
  const readonly = role === 'assistant'
  const [detail, setDetail] = useState<InstanceDetail | null>(null)
  const [teachers, setTeachers] = useState<Teacher[]>([])
  const [classrooms, setClassrooms] = useState<Classroom[]>([])
  const [loading, setLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [adjustForm] = Form.useForm()
  /** 智能推荐时间段 */
  const [suggestions, setSuggestions] = useState<SlotSuggestion[]>([])
  const [noteEditorOpen, setNoteEditorOpen] = useState(false)

  const loadDetail = useCallback(async () => {
    if (!instanceId) return
    setLoading(true)
    try {
      const [d, t, rooms] = await Promise.all([api.getInstanceDetail(instanceId), api.getTeachers(), api.getClassrooms()])
      setDetail(d)
      setTeachers(t)
      setClassrooms(rooms)
    } catch (err) {
      message.error(getErrorMessage(err))
      onClose()
    } finally {
      setLoading(false)
    }
  }, [instanceId, message, onClose])

  useEffect(() => {
    setEditing(false)
    setSuggestions([])
    adjustForm.resetFields()
    loadDetail()
  }, [instanceId, loadDetail, adjustForm])

  // ---------- 考勤操作（仅教务） ----------

  const handleAttendanceChange = async (studentId: number, status: AttendanceStatus | null): Promise<void> => {
    if (!detail) return
    try {
      if (status) {
        await api.saveAttendance({ scheduleInstanceId: detail.instance.id, studentId, status })
      } else {
        await api.removeAttendance({ scheduleInstanceId: detail.instance.id, studentId })
      }
      await loadDetail()
      onChanged()
      window.dispatchEvent(new CustomEvent('vlearn:refresh-alerts'))
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const handleAllPresent = async (): Promise<void> => {
    if (!detail) return
    try {
      const n = await api.markAllPresent(detail.instance.id)
      message.success(`已将 ${n} 名学生标记为出勤`)
      await loadDetail()
      onChanged()
      window.dispatchEvent(new CustomEvent('vlearn:refresh-alerts'))
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  // ---------- 调课 / 取消 / 恢复（仅教务） ----------

  const startEditing = (): void => {
    if (!detail) return
    adjustForm.setFieldsValue({
      date: dayjs(detail.instance.date),
      time: [
        dayjs(detail.instance.date + ' ' + detail.instance.startTime, 'YYYY-MM-DD HH:mm'),
        dayjs(detail.instance.date + ' ' + detail.instance.endTime, 'YYYY-MM-DD HH:mm')
      ],
      actualTeacherId: detail.instance.actualTeacherId ?? detail.course.defaultTeacherId,
      classroomId: detail.instance.classroomId ?? undefined,
      note: detail.instance.note
    })
    setSuggestions([])
    setEditing(true)
  }

  /** Agent：智能推荐时间段（未来 7 天老师的空闲时段） */
  const handleSuggest = async (): Promise<void> => {
    if (!detail) return
    try {
      const slots = await api.suggestSlots(detail.instance.id)
      setSuggestions(slots)
      if (slots.length === 0) message.info('未来 7 天暂未找到空闲时段，可手动选择时间')
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const doSaveAdjust = async (force: boolean): Promise<void> => {
    if (!detail) return
    const values = await adjustForm.validateFields()
    const { date, time, actualTeacherId, classroomId, note } = values as {
      date: Dayjs
      time: [Dayjs, Dayjs]
      actualTeacherId: number | null
      classroomId?: number | null
      note?: string | null
    }
    const payload = {
      date: date.format('YYYY-MM-DD'),
      startTime: time[0].format('HH:mm'),
      endTime: time[1].format('HH:mm'),
      actualTeacherId: actualTeacherId ?? null,
      classroomId: classroomId ?? null,
      note: note ?? null
    }
    // Agent：保存前冲突检测
    if (!force) {
      const conflicts = await api.checkInstanceConflict({ instanceId: detail.instance.id, ...payload })
      if (conflicts.length > 0) {
        await new Promise<void>((resolve, reject) => {
          Modal.confirm({
            title: `检测到 ${conflicts.length} 处时间冲突`,
            width: 560,
            content: <ConflictList conflicts={conflicts} />,
            okText: '仍然保存',
            cancelText: '返回检查',
            onOk: () => resolve(),
            onCancel: () => reject(new Error('已取消保存'))
          })
        })
      }
    }
    setSaving(true)
    await api.updateInstance(detail.instance.id, payload)
    message.success('调课已保存')
    setEditing(false)
    setSuggestions([])
    await loadDetail()
    onChanged()
  }

  const handleSaveAdjust = async (): Promise<void> => {
    try {
      await doSaveAdjust(false)
    } catch (err) {
      if (err instanceof Error && err.message) message.error(getErrorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const handleCancelInstance = async (): Promise<void> => {
    if (!detail) return
    try {
      await api.cancelInstance(detail.instance.id)
      message.success('本次课已取消')
      await loadDetail()
      onChanged()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  const handleRestoreInstance = async (): Promise<void> => {
    if (!detail) return
    try {
      await api.restoreInstance(detail.instance.id)
      message.success('本次课已恢复')
      await loadDetail()
      onChanged()
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  if (!detail) {
    return <Modal open={!!instanceId} onCancel={onClose} footer={null} title="课程详情" />
  }

  const { instance, course, students } = detail
  const isSubstitute = instance.actualTeacherId !== null && instance.actualTeacherId !== course.defaultTeacherId
  const displayTeacher = instance.actualTeacherName ?? course.defaultTeacherName

  const attendanceColumns = [
    {
      title: '学生姓名',
      dataIndex: 'name',
      key: 'name'
    },
    {
      title: '学校班级',
      dataIndex: 'schoolClass',
      key: 'schoolClass',
      render: (v: string | null) => v || '—'
    },
    {
      title: '考勤状态',
      key: 'status',
      width: 180,
      render: (_: unknown, row: { id: number; attendanceStatus: AttendanceStatus | null }) =>
        readonly ? (
          <AttendanceStatusTag status={row.attendanceStatus} />
        ) : (
          <Select
            size="small"
            allowClear
            placeholder="未标记"
            style={{ width: 120 }}
            value={row.attendanceStatus}
            onChange={(v) => handleAttendanceChange(row.id, (v as AttendanceStatus | null) ?? null)}
            options={[
              { value: 'present', label: '出勤' },
              { value: 'leave', label: '请假' },
              { value: 'absent', label: '缺勤' }
            ]}
          />
        )
    }
  ]

  const attendanceRows = students.map((s) => ({
    key: s.id,
    id: s.id,
    name: s.name,
    schoolClass: s.schoolClass,
    attendanceStatus: s.attendanceStatus
  }))

  const attendanceExportRows = students.map((s) => ({
    姓名: s.name,
    学校班级: s.schoolClass ?? '—',
    考勤状态: s.attendanceStatus ? { present: '出勤', leave: '请假', absent: '缺勤' }[s.attendanceStatus] : '未标记'
  }))

  return (
    <Modal
      open={!!instanceId}
      onCancel={onClose}
      footer={null}
      width={760}
      title={`课程详情 · ${course.subject} ${course.grade} ${course.className}`}
    >
      {loading ? null : (
        <>
          <Descriptions bordered size="small" column={2} style={{ marginBottom: 16 }}>
            <Descriptions.Item label="上课日期">{instance.date}</Descriptions.Item>
            <Descriptions.Item label="上课时间">
              {instance.startTime} - {instance.endTime}
            </Descriptions.Item>
            <Descriptions.Item label="默认授课老师">{course.defaultTeacherName || '—'}</Descriptions.Item>
            <Descriptions.Item label="实际授课老师">
              {displayTeacher || '—'}
              {isSubstitute && (
                <Tag color="orange" style={{ marginLeft: 8 }}>
                  代课
                </Tag>
              )}
            </Descriptions.Item>
            <Descriptions.Item label="教室" span={2}>
              {instance.classroomName ?? course.defaultClassroomName ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="状态" span={2}>
              <StatusTag status={instance.status} />
              {instance.note && <span style={{ marginLeft: 8, color: '#888' }}>备注：{instance.note}</span>}
            </Descriptions.Item>
          </Descriptions>

          {/* 调课表单（仅教务） */}
          {editing && !readonly && (
            <Form
              form={adjustForm}
              layout="inline"
              style={{ marginBottom: 16, rowGap: 8, background: '#fafafa', padding: 12, borderRadius: 6 }}
            >
              <Form.Item name="date" label="日期" rules={[{ required: true, message: '请选择日期' }]}>
                <DatePicker />
              </Form.Item>
              <Form.Item name="time" label="时间" rules={[{ required: true, message: '请选择起止时间' }]}>
                <TimePicker.RangePicker format="HH:mm" minuteStep={5} />
              </Form.Item>
              <Form.Item name="actualTeacherId" label="授课老师">
                <Select
                  allowClear
                  placeholder="默认老师"
                  style={{ width: 130 }}
                  options={teachers.map((t) => ({ value: t.id, label: t.name }))}
                />
              </Form.Item>
              <Form.Item name="classroomId" label="教室">
                <Select
                  allowClear
                  placeholder="默认教室"
                  style={{ width: 150 }}
                  options={classroomOptions(classrooms)}
                />
              </Form.Item>
              <Form.Item name="note" label="备注">
                <Input placeholder="如：代课、临时调至…" style={{ width: 150 }} />
              </Form.Item>
              <Form.Item>
                <Space>
                  <Button type="primary" size="small" loading={saving} onClick={() => void handleSaveAdjust()}>
                    保存
                  </Button>
                  <Button size="small" icon={<BulbOutlined />} onClick={() => void handleSuggest()}>
                    智能推荐时间
                  </Button>
                  <Button size="small" onClick={() => setEditing(false)}>
                    取消
                  </Button>
                </Space>
              </Form.Item>
            </Form>
          )}

          {/* 智能推荐时间段（教务） */}
          {suggestions.length > 0 && !readonly && (
            <div style={{ marginBottom: 16, background: '#f6ffed', border: '1px solid #b7eb8f', borderRadius: 6, padding: 10 }}>
              <div style={{ fontWeight: 600, marginBottom: 6 }}>智能推荐时间段（授课老师空闲）：</div>
              <Space wrap>
                {suggestions.map((s, i) => (
                  <Button
                    key={i}
                    size="small"
                    onClick={() =>
                      adjustForm.setFieldsValue({
                        date: dayjs(s.date),
                        time: [dayjs(s.date + ' ' + s.startTime, 'YYYY-MM-DD HH:mm'), dayjs(s.date + ' ' + s.endTime, 'YYYY-MM-DD HH:mm')]
                      })
                    }
                  >
                    {s.date} {s.startTime}-{s.endTime}
                  </Button>
                ))}
              </Space>
            </div>
          )}

          {/* 操作按钮 */}
          <Space wrap style={{ marginBottom: 16 }}>
            {!readonly && instance.status !== 'cancelled' && (
              <Button icon={<EditOutlined />} onClick={startEditing} disabled={editing}>
                单次调课
              </Button>
            )}
            {!readonly &&
              (instance.status === 'cancelled' ? (
                <Button icon={<RollbackOutlined />} onClick={() => void handleRestoreInstance()}>
                  恢复本次课
                </Button>
              ) : (
                <Popconfirm
                  title="确认取消本次课？"
                  description="取消后仍可恢复；已产生的考勤记录会保留。"
                  okText="取消本次课"
                  cancelText="再想想"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void handleCancelInstance()}
                >
                  <Button danger icon={<CloseCircleOutlined />}>
                    取消本次课
                  </Button>
                </Popconfirm>
              ))}
            {!readonly && (
              <Button type="primary" ghost icon={<CheckCircleOutlined />} onClick={() => void handleAllPresent()}>
                全部出勤
              </Button>
            )}
            {readonly && (
              <Button type="primary" icon={<EditOutlined />} onClick={() => setNoteEditorOpen(true)}>
                课程内容记录
              </Button>
            )}
            <ExportExcelButton
              module="考勤记录"
              columns={[
                { header: '学生姓名', key: '姓名' },
                { header: '学校班级', key: '学校班级' },
                { header: '考勤状态', key: '考勤状态' }
              ]}
              rows={attendanceExportRows}
              disabled={students.length === 0}
            />
          </Space>

          {/* 学生考勤名单 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <ScheduleOutlined />
            <span style={{ fontWeight: 600 }}>学生考勤（{students.length} 人）</span>
          </div>
          {students.length === 0 ? (
            <div style={{ color: '#999', padding: '16px 0' }}>暂无报名学生。</div>
          ) : (
            <Table size="small" columns={attendanceColumns} dataSource={attendanceRows} pagination={false} scroll={{ y: 320 }} />
          )}

          {/* 出勤情况小结 */}
          {students.length > 0 && (
            <Space style={{ marginTop: 12 }} size={16}>
              <span>
                <AttendanceStatusTag status="present" /> ×{students.filter((s) => s.attendanceStatus === 'present').length}
              </span>
              <span>
                <AttendanceStatusTag status="leave" /> ×{students.filter((s) => s.attendanceStatus === 'leave').length}
              </span>
              <span>
                <AttendanceStatusTag status="absent" /> ×{students.filter((s) => s.attendanceStatus === 'absent').length}
              </span>
              <span style={{ color: '#999' }}>未标记 ×{students.filter((s) => !s.attendanceStatus).length}</span>
            </Space>
          )}

          {/* 助教：课程内容记录 */}
          {readonly && (
            <LessonNoteEditorModal
              scheduleInstanceId={noteEditorOpen ? instance.id : null}
              onClose={() => setNoteEditorOpen(false)}
              onChanged={onChanged}
            />
          )}
        </>
      )}
    </Modal>
  )
}
