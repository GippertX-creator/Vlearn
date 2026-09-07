/**
 * 课程实例详情弹窗：
 * - 展示课程、时间、老师、状态等基本信息
 * - 教务可操作考勤（出勤/请假/缺勤，三选一，默认未标记，修改立即保存）
 * - 支持一键"全部出勤"、导出本次考勤
 * - 支持单次调课（日期/时间/代课老师）与取消/恢复
 */
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  EditOutlined,
  RollbackOutlined,
  ScheduleOutlined
} from '@ant-design/icons'
import { App as AntdApp, Button, DatePicker, Descriptions, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, TimePicker } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { useCallback, useEffect, useState } from 'react'
import { api, getErrorMessage } from '../api'
import type { AttendanceStatus, InstanceDetail, ScheduleInstance, Teacher } from '../types'
import AttendanceStatusTag from './AttendanceStatusTag'
import ExportExcelButton from './ExportExcelButton'

interface InstanceDetailModalProps {
  instanceId: number | null
  /** 弹窗关闭（不传 instanceId 即关闭） */
  onClose: () => void
  /** 实例或考勤发生变化（父组件需刷新日历数据） */
  onChanged: () => void
}

/** 实例状态标签 */
function StatusTag({ status }: { status: ScheduleInstance['status'] }): JSX.Element {
  if (status === 'adjusted') return <Tag color="orange">已调课</Tag>
  if (status === 'cancelled') return <Tag color="default">已取消</Tag>
  return <Tag color="blue">正常</Tag>
}

export default function InstanceDetailModal({ instanceId, onClose, onChanged }: InstanceDetailModalProps): JSX.Element {
  const { message } = AntdApp.useApp()
  const [detail, setDetail] = useState<InstanceDetail | null>(null)
  const [teachers, setTeachers] = useState<Teacher[]>([])
  const [loading, setLoading] = useState(false)
  /** 是否处于调课编辑状态 */
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [adjustForm] = Form.useForm()

  const loadDetail = useCallback(async () => {
    if (!instanceId) return
    setLoading(true)
    try {
      const [d, t] = await Promise.all([api.getInstanceDetail(instanceId), api.getTeachers()])
      setDetail(d)
      setTeachers(t)
    } catch (err) {
      message.error(getErrorMessage(err))
      onClose()
    } finally {
      setLoading(false)
    }
  }, [instanceId, message, onClose])

  useEffect(() => {
    setEditing(false)
    adjustForm.resetFields()
    loadDetail()
  }, [instanceId, loadDetail, adjustForm])

  // ---------- 考勤操作 ----------

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
    } catch (err) {
      message.error(getErrorMessage(err))
    }
  }

  // ---------- 调课 / 取消 / 恢复 ----------

  const startEditing = (): void => {
    if (!detail) return
    adjustForm.setFieldsValue({
      date: dayjs(detail.instance.date),
      time: [dayjs(detail.instance.date + ' ' + detail.instance.startTime, 'YYYY-MM-DD HH:mm'), dayjs(detail.instance.date + ' ' + detail.instance.endTime, 'YYYY-MM-DD HH:mm')],
      actualTeacherId: detail.instance.actualTeacherId ?? detail.course.defaultTeacherId,
      note: detail.instance.note
    })
    setEditing(true)
  }

  const handleSaveAdjust = async (): Promise<void> => {
    if (!detail) return
    try {
      const values = await adjustForm.validateFields()
      const { date, time, actualTeacherId, note } = values as {
        date: Dayjs
        time: [Dayjs, Dayjs]
        actualTeacherId: number | null
        note?: string | null
      }
      setSaving(true)
      await api.updateInstance(detail.instance.id, {
        date: date.format('YYYY-MM-DD'),
        startTime: time[0].format('HH:mm'),
        endTime: time[1].format('HH:mm'),
        actualTeacherId: actualTeacherId ?? null,
        note: note ?? null
      })
      message.success('调课已保存')
      setEditing(false)
      await loadDetail()
      onChanged()
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
      render: (_: unknown, row: { id: number; attendanceStatus: AttendanceStatus | null }) => (
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
            <Descriptions.Item label="状态" span={2}>
              <StatusTag status={instance.status} />
              {instance.note && <span style={{ marginLeft: 8, color: '#888' }}>备注：{instance.note}</span>}
            </Descriptions.Item>
          </Descriptions>

          {/* 调课表单 */}
          {editing && (
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
              <Form.Item name="note" label="备注">
                <Input placeholder="如：代课、临时调至…" style={{ width: 150 }} />
              </Form.Item>
              <Form.Item>
                <Space>
                  <Button type="primary" size="small" loading={saving} onClick={handleSaveAdjust}>
                    保存
                  </Button>
                  <Button size="small" onClick={() => setEditing(false)}>
                    取消
                  </Button>
                </Space>
              </Form.Item>
            </Form>
          )}

          {/* 操作按钮 */}
          <Space wrap style={{ marginBottom: 16 }}>
            {instance.status !== 'cancelled' && (
              <Button icon={<EditOutlined />} onClick={startEditing} disabled={editing}>
                单次调课
              </Button>
            )}
            {instance.status === 'cancelled' ? (
              <Button icon={<RollbackOutlined />} onClick={handleRestoreInstance}>
                恢复本次课
              </Button>
            ) : (
              <Popconfirm
                title="确认取消本次课？"
                description="取消后仍可恢复；已产生的考勤记录会保留。"
                okText="取消本次课"
                cancelText="再想想"
                okButtonProps={{ danger: true }}
                onConfirm={handleCancelInstance}
              >
                <Button danger icon={<CloseCircleOutlined />}>
                  取消本次课
                </Button>
              </Popconfirm>
            )}
            <Button type="primary" ghost icon={<CheckCircleOutlined />} onClick={handleAllPresent}>
              全部出勤
            </Button>
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
            <div style={{ color: '#999', padding: '16px 0' }}>
              暂无报名学生。请先在「学生管理」中为该课程添加学生。
            </div>
          ) : (
            <Table
              size="small"
              columns={attendanceColumns}
              dataSource={attendanceRows}
              pagination={false}
              scroll={{ y: 320 }}
            />
          )}

          {/* 出勤情况小结 */}
          {students.length > 0 && (
            <Space style={{ marginTop: 12 }} size={16}>
              <span>
                <AttendanceStatusTag status="present" /> ×
                {students.filter((s) => s.attendanceStatus === 'present').length}
              </span>
              <span>
                <AttendanceStatusTag status="leave" /> ×
                {students.filter((s) => s.attendanceStatus === 'leave').length}
              </span>
              <span>
                <AttendanceStatusTag status="absent" /> ×
                {students.filter((s) => s.attendanceStatus === 'absent').length}
              </span>
              <span style={{ color: '#999' }}>
                未标记 ×{students.filter((s) => !s.attendanceStatus).length}
              </span>
            </Space>
          )}
        </>
      )}
    </Modal>
  )
}
